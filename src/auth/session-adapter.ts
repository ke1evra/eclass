/**
 * Login + session adapter — ECLASS-65 / ECLASS-56.
 *
 * Implements the production auth flow per ADR-0007:
 *   - verifies password via payload.login() (Payload = sole credential authority)
 *   - creates exactly ONE Sessions row per login call (each login = independent
 *     session; revoking one does not affect others)
 *   - returns the opaque session id for the cookie; NEVER the JWT or hash
 *
 * The Payload JWT from payload.login() is DISCARDED — it is not used as an
 * application session (ADR-0007). Only the opaque Sessions row is.
 */
import type { Payload } from 'payload'
import { randomBytes } from 'node:crypto'

export interface Clock {
  now(): number
}

export interface LoginInput {
  email: string
  password: string
}

export interface LoginResult {
  ok: true
  sessionId: string
  userId: string
  cookie: {
    httpOnly: boolean
    secure: boolean
    sameSite: 'strict' | 'lax'
    maxAgeMs: number
  }
}

export interface LoginError {
  ok: false
  code: 'invalid_credentials' | 'email_not_confirmed' | 'rate_limited'
}

export interface SessionAdapterOptions {
  payload: Payload
  clock: Clock
  sessionTtlMs: number
}

export function createSessionAdapter(opts: SessionAdapterOptions) {
  const { payload, clock, sessionTtlMs } = opts

  return {
    /**
     * Verify credentials via Payload and create one opaque session row.
     * Returns the session id for the cookie — never the JWT or hash.
     */
    async login(input: LoginInput): Promise<LoginResult | LoginError> {
      // Payload.login verifies the password; throws on bad credentials.
      let loginResult
      try {
        loginResult = await payload.login({
          collection: 'users',
          data: { email: input.email, password: input.password },
        })
      } catch {
        return { ok: false, code: 'invalid_credentials' }
      }
      if (!loginResult.user) return { ok: false, code: 'invalid_credentials' }

      const user = loginResult.user as { id: string; emailConfirmed?: boolean; blocked?: boolean }
      if (user.blocked) return { ok: false, code: 'invalid_credentials' }
      if (user.emailConfirmed === false) return { ok: false, code: 'email_not_confirmed' }

      // Create exactly ONE session row per login.
      const sessionId = randomBytes(18).toString('base64url')
      await payload.create({
        collection: 'sessions',
        data: {
          sessionId,
          userId: user.id,
          role: 'teacher',
          expiresAt: clock.now() + sessionTtlMs,
          revoked: false,
        },
        overrideAccess: true,
      })

      return {
        ok: true,
        sessionId,
        userId: user.id,
        cookie: {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          maxAgeMs: sessionTtlMs,
        },
      }
    },

    /** Revoke a session by its opaque id (logout). */
    async logout(sessionId: string): Promise<void> {
      const found = await payload.find({
        collection: 'sessions',
        where: { sessionId: { equals: sessionId } },
        limit: 1,
        overrideAccess: true,
      })
      const doc = found.docs[0] as { id: string } | undefined
      if (doc) {
        await payload.update({
          collection: 'sessions',
          id: doc.id,
          data: { revoked: true },
          overrideAccess: true,
        })
      }
    },
  }
}
