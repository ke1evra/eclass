/**
 * Server-side wiring for class & invite services — ECLASS-56.
 *
 * The Payload-backed store replaces the in-memory Maps on the production
 * path. Both services keep their domain authorization: every call takes the
 * Actor resolved from the session cookie.
 */
import type { Payload } from 'payload'
import { createPayloadClassStore } from './payload-store'
import { createClassService } from './service'
import { createInviteService } from './invite'
import { ensureInvitesHashed } from './invite-migration'

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000

export function getClassServices(payload: Payload) {
  // First server touch converts any legacy plaintext invite rows (ECLASS-57).
  void ensureInvitesHashed(payload)
  const store = createPayloadClassStore(payload)
  const clock = { now: () => Date.now() }
  return {
    classService: createClassService({ store }),
    inviteService: createInviteService({ store, clock, ttlMs: INVITE_TTL_MS }),
  }
}

/** HTTP status for a service error code (shared by every class route). */
export const classStatus = (code: string): number => {
  switch (code) {
    case 'not_found':
      return 404
    case 'forbidden':
      return 403
    case 'conflict':
      return 409
    case 'validation_error':
      return 422
    default:
      return 400
  }
}
