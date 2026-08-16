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
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

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
  /** Sliding window for rate limiting; failures older than this are expunged. */
  rateLimitWindowMs?: number
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD = 8
const DEFAULT_MAX_FAILED = 5
const DEFAULT_RATE_WINDOW_MS = 15 * 60 * 1000
const SCRYPT_KEYLEN = 32

/**
 * Per-user salted password hashing (CB-5, hardened in ECLASS-59). scrypt with
 * a unique random salt per user, ASYNC — the synchronous variant blocked the
 * event loop on every login (ECLASS-59 acceptance). The stored string is
 * versioned — `scrypt-1$<N>$<r>$<p>$saltHex$hashHex` — so parameters can be
 * raised later without invalidating existing hashes: verify() reads the
 * version and dispatches to the matching derivation.
 */
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const
const SCRYPT_VERSION = `scrypt-1`

const scryptAsync = (password: string, salt: Buffer, keylen: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p }, (err, derived) =>
      err ? reject(err) : resolve(derived),
    )
  })

const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN)
  return `${SCRYPT_VERSION}$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('hex')}$${hash.toString('hex')}`
}

const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$')
  // Legacy unversioned format `saltHex$hashHex` (default params).
  if (parts.length === 2) {
    const [saltHex, hashHex] = parts
    const computed = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, Buffer.from(saltHex!, 'hex'), SCRYPT_KEYLEN, (err, d) =>
        err ? reject(err) : resolve(d),
      )
    })
    const expected = Buffer.from(hashHex!, 'hex')
    return computed.length === expected.length && timingSafeEqual(computed, expected)
  }
  const [version, nHex, rHex, pHex, saltHex, hashHex] = parts
  if (version !== SCRYPT_VERSION || !nHex || !rHex || !pHex || !saltHex || !hashHex) return false
  const computed = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(saltHex, 'hex'),
      SCRYPT_KEYLEN,
      { N: Number(nHex), r: Number(rHex), p: Number(pHex) },
      (err, d) => (err ? reject(err) : resolve(d)),
    )
  })
  const expected = Buffer.from(hashHex, 'hex')
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

export function createAuthService(opts: Options): AuthService {
  const { store, clock, sessionTtlMs } = opts
  const maxFailed = opts.maxFailedAttempts ?? DEFAULT_MAX_FAILED
  const rateWindow = opts.rateLimitWindowMs ?? DEFAULT_RATE_WINDOW_MS
  /**
   * Sliding-window rate limit (CB-5): each email maps to the timestamps of its
   * recent failures. We prune entries older than `rateWindow` before counting,
   * so a legitimate user is unlocked again once the window passes — and a
   * correct password clears the window immediately.
   */
  const failedAtByIp = new Map<string, number[]>()

  const recentFailures = (email: string): number[] => {
    const now = clock.now()
    const all = failedAtByIp.get(email) ?? []
    const recent = all.filter((t) => now - t < rateWindow)
    failedAtByIp.set(email, recent)
    return recent
  }

  const recordFailure = (email: string): void => {
    const recent = recentFailures(email)
    recent.push(clock.now())
    failedAtByIp.set(email, recent)
  }

  const clearFailures = (email: string): void => {
    failedAtByIp.delete(email)
  }

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
        passwordHash: await hashPassword(password),
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
      if (recentFailures(email).length >= maxFailed) {
        return { ok: false, code: 'rate_limited' }
      }
      if (!EMAIL_RE.test(email) || password.length < MIN_PASSWORD) {
        // count as a failure to slow brute force on obviously-bad input
        recordFailure(email)
        return { ok: false, code: 'invalid_credentials' }
      }

      const user = await store.findUserByEmail(email)
      // SAME failure code whether user is missing OR password is wrong.
      const passwordOk = user ? await verifyPassword(password, user.passwordHash) : false
      if (!user || !passwordOk) {
        recordFailure(email)
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
      clearFailures(email)
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
