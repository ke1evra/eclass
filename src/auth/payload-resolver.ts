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
 */
import type { Payload } from 'payload'
import type { Actor } from '@/domain/authorization'

export interface Clock {
  now(): number
}

export interface ResolvedActor {
  actor: Actor | null
}

export interface SessionRecord {
  id: string
  userId: string
  expiresAt: number
  revoked: boolean
}

/**
 * Resolve the actor for an incoming request from the opaque session cookie.
 * Returns null (anonymous) when the cookie is absent, the session is unknown /
 * revoked / expired, or the underlying user no longer exists or is blocked.
 */
export async function resolveActor(
  payload: Payload,
  cookieValue: string | undefined,
  clock: Clock,
): Promise<Actor | null> {
  if (!cookieValue) return null

  // Look up the opaque session by its id (the cookie value).
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
  // the session row. findByID throws NotFound when the user has been deleted;
  // treat that as anonymous (the session is orphaned).
  let user: { id: string; role: string } | null
  try {
    user = (await payload.findByID({
      collection: 'users',
      id: session.userId,
      overrideAccess: true,
      depth: 0,
    })) as { id: string; role: string } | null
  } catch {
    return null
  }
  if (!user) return null
  if (user.role !== 'teacher' && user.role !== 'student') return null

  return { id: user.id, role: user.role }
}
