/**
 * Shared-storage rate limiter — ECLASS-59.
 *
 * Sliding-window limiter backed by MongoDB (the store every app instance
 * already shares). Replaces the process-local Maps whose counters vanished on
 * restart and diverged across instances: two app processes hitting the same
 * Mongo see the SAME window, and a restart does not reset anything.
 *
 * Design points (task acceptance):
 *   - SLIDING WINDOW: a key holds the timestamps of its recent attempts; an
 *     atomic findOneAndUpdate($push) records the hit and returns the window in
 *     one round-trip — a race cannot under-count.
 *   - KEYS NEVER STORE IDENTIFIERS: the account component is
 *     sha256(normalized login) truncated — the rate collection holds no
 *     emails, and the source component is the client IP from
 *     x-forwarded-for/x-real-ip ('unknown' when absent).
 *   - NO EXISTENCE LEAK: allowed/denied depends only on the key, never on
 *     whether the account exists.
 *   - TTL: documents expire via a TTL index on updatedAt (4× window).
 */
import { createHash } from 'node:crypto'
import type { Collection } from 'mongodb'
import type { Payload } from 'payload'

/** The raw shape of a window document (string keys — not ObjectIds). */
type RateDoc = { _id: string; hits: number[]; updatedAt: number }

export interface RateLimitClock {
  now(): number
}

export interface RateLimitDecision {
  allowed: boolean
  /** Milliseconds until the oldest in-window attempt ages out (0 when allowed). */
  retryAfterMs: number
}

export interface RateLimiter {
  hit(key: string): Promise<RateLimitDecision>
}

export interface MongoRateLimiterOptions {
  payload: Payload
  clock: RateLimitClock
  windowMs: number
  max: number
  /** Mongo collection name (default 'rate-limits'). */
  collection?: string
}

/** Cap on stored timestamps per key — bounds document growth under attack. */
const MAX_HITS_PER_KEY = 512

export const normalizeLogin = (login: string): string => login.trim().toLowerCase()

/** Privacy-safe account component: truncated sha256, never the raw login. */
export const accountComponent = (login: string): string =>
  createHash('sha256').update(normalizeLogin(login)).digest('hex').slice(0, 24)

/** Client IP from standard proxy headers; 'unknown' when nothing is available. */
export const clientIp = (headers: Headers): string => {
  const fwd = headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return headers.get('x-real-ip')?.trim() || 'unknown'
}

export function createMongoRateLimiter(opts: MongoRateLimiterOptions): RateLimiter {
  const { payload, clock, windowMs, max } = opts
  const collectionName = opts.collection ?? 'rate-limits'

  let indexPromise: Promise<unknown> | null = null
  const ensureTtlIndex = async (): Promise<void> => {
    if (!indexPromise) {
      indexPromise = payload.db.connection
        .createCollection(collectionName)
        .catch(() => undefined)
        .then(() =>
          payload.db.connection
            .collection(collectionName)
            .createIndex({ updatedAt: 1 }, { expireAfterSeconds: Math.ceil((windowMs * 4) / 1000) }),
        )
        .catch(() => undefined)
    }
    await indexPromise
  }

  return {
    async hit(key) {
      const now = clock.now()
      await ensureTtlIndex()

      const coll = payload.db.connection.collection(collectionName) as unknown as Collection<RateDoc>
      const doc = await coll.findOneAndUpdate(
        { _id: key },
        {
          $push: { hits: { $each: [now], $slice: -MAX_HITS_PER_KEY } },
          $set: { updatedAt: now },
        },
        { upsert: true, returnDocument: 'after' as const },
      )

      const hits: number[] = Array.isArray(doc?.hits) ? doc!.hits : [now]
      const inWindow = hits.filter((t) => now - t < windowMs)
      if (inWindow.length <= max) {
        return { allowed: true, retryAfterMs: 0 }
      }
      const oldest = inWindow[0]!
      return { allowed: false, retryAfterMs: Math.max(1, windowMs - (now - oldest)) }
    },
  }
}

/**
 * Route-level policy for auth mutations: the buckets and limits shared by
 * login / signup / confirm / resend / join. Fail-closed — an infrastructure
 * failure of the limiter REJECTS the auth mutation (503) rather than letting
 * it through unmetered.
 */
export interface RateLimitPolicy {
  windowMs: number
  max: number
}

export const LOGIN_RATE: RateLimitPolicy = { windowMs: 15 * 60 * 1000, max: 10 }
/** Generous per-source cap above the per-account one: stops attackers who
 *  rotate emails, tolerates a whole classroom behind one NAT. */
export const LOGIN_IP_RATE: RateLimitPolicy = { windowMs: 15 * 60 * 1000, max: 100 }
export const SIGNUP_RATE: RateLimitPolicy = { windowMs: 60 * 60 * 1000, max: 10 }
export const SIGNUP_IP_RATE: RateLimitPolicy = { windowMs: 60 * 60 * 1000, max: 20 }
export const CONFIRM_RATE: RateLimitPolicy = { windowMs: 15 * 60 * 1000, max: 20 }
export const RESEND_RATE: RateLimitPolicy = { windowMs: 60 * 60 * 1000, max: 5 }
export const JOIN_RATE: RateLimitPolicy = { windowMs: 60 * 60 * 1000, max: 15 }
export const JOIN_IP_RATE: RateLimitPolicy = { windowMs: 60 * 60 * 1000, max: 30 }
/**
 * Per-CODE window (ECLASS-59 hardening): an invite code carries ~40 bits —
 * hashing at rest does not stop ONLINE guessing. This bucket caps attempts on
 * a specific code regardless of IP/login rotation (the code itself is hashed
 * into the key). 10 tries / 15 min still tolerates a student's typos while
 * making brute force hopeless.
 */
export const JOIN_CODE_RATE: RateLimitPolicy = { windowMs: 15 * 60 * 1000, max: 10 }

/**
 * Shared enforcement for handlers: builds the composite key (bucket + account
 * + source IP), records the hit, and returns a ready 429 Response (with
 * Retry-After) or null when the request is allowed. Throws propagate to the
 * caller's fail-closed 503 path.
 */
export async function enforceRateLimit(args: {
  payload: Payload
  headers: Headers
  bucket: string
  policy: RateLimitPolicy
  /** Account identifier (login/email); hashed into the key, never stored raw. */
  account?: string
  /**
   * false → the key carries NO ip component: the window is scoped purely to
   * the account (e.g. a specific invite code) and rotation of source IPs
   * cannot bypass it. Default true (source-aware windows).
   */
  includeIp?: boolean
}): Promise<Response | null> {
  const limiter = createMongoRateLimiter({
    payload: args.payload,
    clock: { now: () => Date.now() },
    windowMs: args.policy.windowMs,
    max: args.policy.max,
  })

  const parts = [args.bucket]
  if (args.includeIp !== false) parts.push(`ip:${clientIp(args.headers)}`)
  if (args.account) parts.push(`acct:${accountComponent(args.account)}`)

  const decision = await limiter.hit(parts.join('|'))
  if (decision.allowed) return null

  return new Response(JSON.stringify({ ok: false, code: 'rate_limited' }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
    },
  })
}
