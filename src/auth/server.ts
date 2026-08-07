/**
 * Server-side wiring for auth — CB-4 (ECLASS-51).
 *
 * Provides a singleton session resolver backed by an in-memory store for the
 * skeleton. The real Payload-backed session store replaces this without
 * touching call sites. Crucially, NO identity is ever read from a URL — only
 * from the cookie via resolveSession().
 */
import { createSessionResolver, type SessionStore } from './session'

let cached: ReturnType<typeof createSessionResolver> | null = null

const buildStore = (): SessionStore => {
  const sessions = new Map<string, { userId: string; role: 'teacher' | 'student'; expiresAt: number; revoked: boolean }>()
  return {
    async getSession(id) {
      return sessions.get(id)
    },
  }
}

export const SESSION_COOKIE = 'eclass_session'

export function getSessionResolver() {
  if (!cached) {
    cached = createSessionResolver({
      store: buildStore(),
      clock: { now: () => Date.now() },
    })
  }
  return cached
}
