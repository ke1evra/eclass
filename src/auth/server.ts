/**
 * Server-side auth wiring for pages — ECLASS-56 (Stage B) / ECLASS-13 (E8).
 *
 * Payload/MongoDB is the ONLY session authority at the application boundary:
 * the opaque `eclass_session` cookie resolves through resolveActor (Sessions
 * row → Users row). The previous Map-backed resolver is gone from the
 * production path — restarts no longer log anyone out.
 *
 * E8 distinction (review fix): a request WITHOUT a cookie is anonymous (A2
 * notice=auth); a request WITH a cookie that no longer resolves — expired,
 * revoked, forged — is a DEAD session and pages send the user to A2 with
 * notice=expired («Сессия истекла — войдите снова»). Before the fix both
 * landed on the generic auth notice and E8 was unreachable.
 */
import { cookies } from 'next/headers'
import { getPayload } from 'payload'
import type { Actor } from '@/domain/authorization'
import config from '@/payload.config'
import { resolveActor } from './payload-resolver'
import { SESSION_COOKIE } from './route-actor'

export { SESSION_COOKIE }

export type SessionState = 'ok' | 'anonymous' | 'dead'

export interface PageAuth {
  actor: Actor | null
  sessionState: SessionState
}

/**
 * Resolve the page-level actor from the request cookies. `dead` means the
 * browser PRESENTED a session cookie that no longer resolves (expired,
 * revoked, forged or unknown) — the E8 state. Re-throws infrastructure errors
 * (they must surface as 5xx, not silently log the user out).
 */
export async function getPageAuth(): Promise<PageAuth> {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value
  if (!sessionId) return { actor: null, sessionState: 'anonymous' }

  const payload = await getPayload({ config })
  const actor = await resolveActor(payload, sessionId, { now: () => Date.now() })
  return actor
    ? { actor, sessionState: 'ok' }
    : { actor: null, sessionState: 'dead' }
}

/** Convenience for call sites that only need the actor. */
export async function getPageActor(): Promise<Actor | null> {
  return (await getPageAuth()).actor
}
