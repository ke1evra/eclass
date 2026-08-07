/**
 * Session resolver — CB-4 (ECLASS-51).
 *
 * The single way the app learns "who is the caller": from a server-side
 * session cookie. There is NO overload that trusts a caller-supplied id —
 * by construction, identity cannot come from a URL, body, or query param.
 *
 * Used by route handlers and server components to turn a cookie into an
 * authenticated `Actor` (or null) before any service call.
 */
import type { Actor } from '@/domain/authorization'

export interface Clock {
  now(): number
}

export interface StoredSession {
  userId: string
  role: 'teacher' | 'student'
  expiresAt: number
  revoked: boolean
}

export interface SessionStore {
  getSession(id: string): Promise<StoredSession | undefined>
}

interface Options {
  store: SessionStore
  clock: Clock
}

export function createSessionResolver(opts: Options) {
  return {
    opts,
    /**
     * @param cookieValue the opaque session id from the cookie (or undefined).
     * @returns the authenticated Actor, or null if no/invalid/expired/revoked.
     */
    async resolveSession(cookieValue: string | undefined): Promise<Actor | null> {
      if (!cookieValue) return null
      const session = await opts.store.getSession(cookieValue)
      if (!session) return null
      if (session.revoked) return null
      if (opts.clock.now() >= session.expiresAt) return null
      return { id: session.userId, role: session.role }
    },
  }
}
