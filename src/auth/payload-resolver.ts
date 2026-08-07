/**
 * Payload-backed auth resolver — ECLASS-65.
 *
 * Single auth authority (ADR-0007):
 *   cookie (opaque session id) → Sessions row (not revoked, not expired)
 *   → Users row (current role/blocked, the source of truth) → Actor | null.
 *
 * The password hash is NEVER read here. The session stores only userId + a
 * server-issued opaque id; role/blocked are re-read from the User on every
 * resolution so a role change or block takes effect immediately on the
 * existing session.
 *
 * Error handling: a missing cookie, unknown/expired/revoked session, deleted or
 * blocked user all yield `null` (anonymous). But a transient Mongo/Payload
 * failure is RE-THROWN — masking infrastructure errors as anonymous would let
 * an attacker DoS the store to widen access, and would hide real outages.
 */
import type { Payload } from 'payload'
import { APIError } from 'payload'
import type { Actor } from '@/domain/authorization'

export interface Clock {
  now(): number
}

export interface SessionRecord {
  id: string
  userId: string
  expiresAt: number
  revoked: boolean
}

const isNotFound = (err: unknown): boolean =>
  err instanceof APIError && (err as { status?: number }).status === 404

/**
 * Resolve the actor for an incoming request from the opaque session cookie.
 * Returns null (anonymous) when the cookie is absent, the session is unknown /
 * revoked / expired, the user is deleted or blocked. Re-throws infrastructure
 * errors (DB down, etc.) so they surface as 5xx, not silent anonymous.
 */
export async function resolveActor(
  payload: Payload,
  cookieValue: string | undefined,
  clock: Clock,
): Promise<Actor | null> {
  if (!cookieValue) return null

  // Look up the opaque session by its id (the cookie value). A find() that
  // returns no docs is the "unknown session" anonymous path; an actual DB
  // error propagates.
  const sessionResult = await payload.find({
    collection: 'sessions',
    where: { sessionId: { equals: cookieValue } },
    limit: 1,
    overrideAccess: true,
    depth: 0,
  })
  const session = sessionResult.docs[0] as SessionRecord | undefined
  if (!session) return null
  if (session.revoked) return null
  if (clock.now() >= session.expiresAt) return null

  // Re-read the user — role/blocked are the source of truth, never cached in
  // the session row. findByID throws NotFound (404 APIError) when the user has
  // been deleted; that's an anonymous path. Any OTHER error re-throws.
  let user: { id: string; role: string; blocked?: boolean }
  try {
    user = (await payload.findByID({
      collection: 'users',
      id: session.userId,
      overrideAccess: true,
      depth: 0,
    })) as { id: string; role: string; blocked?: boolean }
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
  if (user.blocked) return null
  if (user.role !== 'teacher' && user.role !== 'student') return null

  return { id: user.id, role: user.role as Actor['role'] }
}
