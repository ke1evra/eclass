/**
 * Server-side auth wiring for pages — ECLASS-56 (Stage B).
 *
 * Payload/MongoDB is the ONLY session authority at the application boundary:
 * the opaque `eclass_session` cookie resolves through resolveActor (Sessions
 * row → Users row). The previous Map-backed resolver is gone from the
 * production path — restarts no longer log anyone out.
 */
import { cookies } from 'next/headers'
import { getPayload } from 'payload'
import type { Actor } from '@/domain/authorization'
import config from '@/payload.config'
import { resolveActor } from './payload-resolver'
import { SESSION_COOKIE } from './route-actor'

export { SESSION_COOKIE }

/**
 * Resolve the page-level actor from the request cookies. Returns null for
 * anonymous visitors; re-throws infrastructure errors (they must surface as
 * 5xx, not silently log the user out).
 */
export async function getPageActor(): Promise<Actor | null> {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value
  const payload = await getPayload({ config })
  return resolveActor(payload, sessionId, { now: () => Date.now() })
}
