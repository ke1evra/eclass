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
import { APIError } from 'payload'
import { randomBytes } from 'node:crypto'

/**
 * A Payload authentication failure is an APIError with status 401. Everything
 * else thrown from payload.login() (5xx, network, DB) is an infrastructure
 * error and MUST propagate — masking it as `invalid_credentials` hides real
 * outages (blocker 3, ECLASS-65 audit). Mirrors `isNotFound` in
 * payload-resolver.ts.
 */
const isAuthError = (err: unknown): boolean =>
  err instanceof APIError && (err as { status?: number }).status === 401

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
  // NOTE: `rate_limited` is intentionally absent — rate limiting is not yet
  // wired (TODO ECLASS-59). The contract will gain that variant when ECLASS-59
  // ships an actual limiter; declaring it now would be a false contract.
  code: 'invalid_credentials' | 'email_not_confirmed'
}

export interface SessionAdapterOptions {
  payload: Payload
  clock: Clock
  sessionTtlMs: number
}

/**
 * Create exactly ONE opaque Sessions row for an ALREADY-AUTHENTICATED user
 * (signup→confirm→login uses login(); the atomic invite join ECLASS-57 uses
 * this after its transaction commits). Returns the cookie descriptor — never
 * a JWT, never a hash.
 */
export async function issueSession(
  payload: Payload,
  user: { id: string; role: 'teacher' | 'student' },
  clock: Clock,
  sessionTtlMs: number,
): Promise<LoginResult> {
  const sessionId = randomBytes(18).toString('base64url')
  await payload.create({
    collection: 'sessions',
    data: {
      sessionId,
      userId: user.id,
      role: user.role,
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
}

export function createSessionAdapter(opts: SessionAdapterOptions) {
  const { payload, clock, sessionTtlMs } = opts

  return {
    /**
     * Verify credentials via Payload and create one opaque session row.
     * Returns the session id for the cookie — never the JWT or hash.
     */
    async login(input: LoginInput): Promise<LoginResult | LoginError> {
      // Payload.login verifies the password; throws APIError(401) on bad
      // credentials. Any OTHER throw (5xx, network, DB) re-throws so the route
      // can surface it as 5xx instead of masking it as invalid_credentials.
      let loginResult
      try {
        loginResult = await payload.login({
          collection: 'users',
          data: { email: input.email, password: input.password },
        })
      } catch (err) {
        if (isAuthError(err)) return { ok: false, code: 'invalid_credentials' }
        throw err
      }
      if (!loginResult.user) return { ok: false, code: 'invalid_credentials' }

      const user = loginResult.user as {
        id: string
        emailConfirmed?: boolean
        blocked?: boolean
        role?: 'teacher' | 'student'
      }
      if (user.blocked) return { ok: false, code: 'invalid_credentials' }
      if (user.emailConfirmed === false) return { ok: false, code: 'email_not_confirmed' }

      // One login = exactly ONE session row (see issueSession).
      return issueSession(
        payload,
        { id: user.id, role: user.role ?? 'teacher' },
        clock,
        sessionTtlMs,
      )
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
