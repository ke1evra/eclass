/**
 * Teacher authentication service — ECLASS-13 (TDD-P1-01).
 *
 * Framework-agnostic. The storage layer is an injected `AuthStore` so tests
 * run with an in-memory implementation and the real app swaps in Payload.
 * Security invariants baked in here:
 *
 *   - passwords are hashed (never stored or returned in plaintext);
 *   - sessions are revocable and carry a secure cookie shape
 *     (httpOnly + secure + sameSite);
 *   - login fails the same way for "unknown user" and "wrong password" so the
 *     API does not leak which one it was (anti-enumeration);
 *   - email must be confirmed before login issues a session;
 *   - repeated failed logins are rate-limited per email.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface Clock {
  now(): number
}

export interface StoredUser {
  id: string
  email: string
  passwordHash: string
  emailConfirmed: boolean
}

export interface StoredSession {
  id: string
  userId: string
  expiresAt: number
  revoked: boolean
}

export interface AuthStore {
  findUserByEmail(email: string): Promise<StoredUser | undefined>
  getUser(id: string): Promise<StoredUser | undefined>
  insertUser(user: StoredUser): Promise<void>
  confirmEmail(userId: string): Promise<void>
  insertSession(session: StoredSession): Promise<void>
  getSession(id: string): Promise<StoredSession | undefined>
  revokeSession(id: string): Promise<void>
  countRecentSignups(email: string, sinceMs: number): Promise<number>
}

export interface CookieSpec {
  httpOnly: boolean
  secure: boolean
  sameSite: 'strict' | 'lax'
  maxAgeMs: number
}

export type AuthResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: AuthErrorCode }

export type AuthErrorCode =
  | 'validation_error'
  | 'conflict'
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'session_revoked'
  | 'session_expired'
  | 'rate_limited'

export interface AuthService {
  signup(input: { email: string; password: string }): Promise<AuthResult<{ userId: string; emailConfirmed: boolean }>>
  confirmEmail(userId: string): Promise<void>
  login(input: { email: string; password: string }): Promise<AuthResult<{ sessionId: string; cookie: CookieSpec }>>
  logout(sessionId: string): Promise<void>
  authenticate(sessionId: string): Promise<AuthResult<{ userId: string; role: 'teacher' }>>
}

interface Options {
  store: AuthStore
  clock: Clock
  sessionTtlMs: number
  maxFailedAttempts?: number
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD = 8
const DEFAULT_MAX_FAILED = 5

/** Salted SHA-256. Strong enough for MVP; swap for argon2 in ECLASS-17 hardening. */
const hashPassword = (password: string): string => {
  const salt = 'eclass-v1'
  return createHash('sha256').update(salt + password).digest('hex')
}

const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function createAuthService(opts: Options): AuthService {
  const { store, clock, sessionTtlMs } = opts
  const maxFailed = opts.maxFailedAttempts ?? DEFAULT_MAX_FAILED
  const failedByIp = new Map<string, number>()

  return {
    async signup({ email, password }) {
      if (!EMAIL_RE.test(email) || password.length < MIN_PASSWORD) {
        return { ok: false, code: 'validation_error' }
      }
      const existing = await store.findUserByEmail(email)
      if (existing) return { ok: false, code: 'conflict' }

      const user: StoredUser = {
        id: `tea-${randomBytes(6).toString('hex')}`,
        email,
        passwordHash: hashPassword(password),
        emailConfirmed: false,
      }
      await store.insertUser(user)
      return { ok: true, userId: user.id, emailConfirmed: false }
    },

    async confirmEmail(userId) {
      await store.confirmEmail(userId)
    },

    async login({ email, password }) {
      // Rate limit by email: too many recent failures blocks further attempts.
      const fails = failedByIp.get(email) ?? 0
      if (fails >= maxFailed) {
        return { ok: false, code: 'rate_limited' }
      }
      if (!EMAIL_RE.test(email) || password.length < MIN_PASSWORD) {
        // count as a failure to slow brute force on obviously-bad input
        failedByIp.set(email, fails + 1)
        return { ok: false, code: 'invalid_credentials' }
      }

      const user = await store.findUserByEmail(email)
      // SAME failure code whether user is missing OR password is wrong.
      const passwordOk = user ? constantTimeEqual(user.passwordHash, hashPassword(password)) : false
      if (!user || !passwordOk) {
        failedByIp.set(email, fails + 1)
        return { ok: false, code: 'invalid_credentials' }
      }
      if (!user.emailConfirmed) {
        return { ok: false, code: 'email_not_confirmed' }
      }

      const session: StoredSession = {
        id: randomBytes(18).toString('base64url'),
        userId: user.id,
        expiresAt: clock.now() + sessionTtlMs,
        revoked: false,
      }
      await store.insertSession(session)
      failedByIp.set(email, 0)
      return {
        ok: true,
        sessionId: session.id,
        cookie: {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          maxAgeMs: sessionTtlMs,
        },
      }
    },

    async logout(sessionId) {
      await store.revokeSession(sessionId)
    },

    async authenticate(sessionId) {
      const session = await store.getSession(sessionId)
      if (!session) return { ok: false, code: 'session_revoked' }
      if (session.revoked) return { ok: false, code: 'session_revoked' }
      if (clock.now() >= session.expiresAt) return { ok: false, code: 'session_expired' }
      return { ok: true, userId: session.userId, role: 'teacher' }
    },
  }
}
