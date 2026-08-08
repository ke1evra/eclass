/**
 * Email confirmation factory — ECLASS-67 (v2, outbox-pattern).
 *
 * v1 had a non-atomic signup: create user → persist hash → call transport. If
 * the hash write or transport call failed, the user was already created, the
 * raw token was lost forever, and a duplicate-email conflict blocked the retry.
 * v2 fixes this with an outbox pattern:
 *
 *   issue({email, password}):
 *     - generate raw token + sha256 hash + expiry
 *     - in ONE Mongo transaction: create the user (with hash+expiry) AND a
 *       pending `email-jobs` row whose body carries the raw token
 *     - commit, or on ANY failure roll back BOTH — the user does not exist
 *       and the duplicate-email retry is clean
 *     - the transport is NEVER called here; a background worker drains the
 *       outbox separately (email delivery cannot be rolled back by a DB
 *       transaction, so it must be decoupled)
 *
 *   resend({email}):
 *     - find the unconfirmed user by email; if none, return null (caller
 *       surfaces a generic 200 to avoid email enumeration)
 *     - regenerate a fresh token/hash/expiry, update the user, and write a new
 *       `email-jobs` row — all in one transaction
 *
 *   confirm(rawToken):
 *     - atomic conditional update-by-where on (hash, !confirmed, !expired)
 *     - DETERMINISTIC under concurrency: a Mongo WriteConflict (code 112) or
 *       TransientTransactionError is retried (≤3 attempts); on retry the
 *       winner has already nulled the hash, so the loser matches zero docs
 *       → 'invalid'. Result: exactly one 'ok', the rest 'invalid' — never a
 *       503 leaking the race to the client.
 *     - returns 'ok' | 'invalid' (anti-enumeration); infra errors throw → 503
 *
 * The raw token lives ONLY in `email-jobs.body` (until delivered) and in the
 * email itself — never in `users`, never in a response body.
 */
import type { Payload } from 'payload'
import { randomBytes, createHash } from 'node:crypto'

export interface Clock {
  now(): number
}

export interface EmailConfirmOptions {
  payload: Payload
  clock: Clock
  /** Token lifetime in ms. Typically 24h. */
  ttlMs: number
}

export type ConfirmResult = 'ok' | 'invalid'

const sha256hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

/**
 * A Mongo write conflict during a conditional update is retry-able: the loser
 * can re-evaluate the where-clause and will find the hash already nulled by
 * the winner. Payload/Mongo surface these as a raw MongoServerError (NOT an
 * APIError) with code 112 or the documented errorLabels. Verified against
 * node_modules/@payloadcms/db-mongodb (handleError.js wraps only E11000).
 */
const isTransientWriteConflict = (err: unknown): boolean => {
  const code = (err as { code?: number }).code
  const labels = (err as { errorLabels?: string[] }).errorLabels
  return (
    code === 112 || // WriteConflict
    Boolean(labels?.includes('TransientTransactionError')) ||
    Boolean(labels?.includes('UnknownTransactionCommitResult'))
  )
}

const CONFIRM_SUBJECT = 'Confirm your email'
const confirmLink = (token: string) => `/api/auth/confirm?token=${token}`

/**
 * Begin a Mongo transaction or throw. Payload returns null when transactions
 * are unavailable (e.g. standalone mongod, or transactionOptions: false) — in
 * that case the outbox atomicity guarantee is impossible, so we fail loudly
 * rather than silently degrade.
 */
const beginTx = async (payload: Payload): Promise<string | number> => {
  const tx = await payload.db.beginTransaction()
  if (tx === null) {
    throw new Error('transactions unavailable — Mongo must run as a replica set')
  }
  return tx
}

export function createEmailConfirm(opts: EmailConfirmOptions) {
  const { payload, clock, ttlMs } = opts

  /**
   * Generate a fresh token, persist its SHA-256 hash + expiry on the user, and
   * write a pending `email-jobs` row carrying the raw token — all in ONE
   * transaction so the user and the deliverable link live or die together.
   * Returns the new userId. The transport is NOT called here (outbox).
   */
  async function issueCredential(userId: string, email: string): Promise<void> {
    const token = randomBytes(24).toString('base64url')
    const hash = sha256hex(token)
    const expiresAt = clock.now() + ttlMs
    const now = clock.now()

    const tx = await beginTx(payload)
    try {
      await payload.update({
        collection: 'users',
        id: userId,
        data: {
          emailConfirmationTokenHash: hash,
          emailConfirmationTokenExpiresAt: expiresAt,
        },
        req: { transactionID: tx },
        overrideAccess: true,
      })
      await payload.create({
        collection: 'email-jobs',
        data: {
          userId,
          to: email,
          subject: CONFIRM_SUBJECT,
          body: confirmLink(token),
          status: 'pending',
          attempts: 0,
          createdAt: now,
        },
        req: { transactionID: tx },
        overrideAccess: true,
      })
      await payload.db.commitTransaction(tx)
    } catch (err) {
      await payload.db.rollbackTransaction(tx)
      throw err
    }
  }

  return {
    /**
     * Signup-time credential issuance. Creates the user (role forced to
     * 'teacher' by the Users beforeChange hook) WITH the confirmation hash +
     * expiry, and a pending email-job, in one transaction. On any failure the
     * user is NOT created — a retry with the same email will not hit a
     * duplicate-key conflict, and no raw token is orphaned.
     *
     * Throws ValidationError (status 400, from E11000) on duplicate email —
     * the caller maps that to 409. Other errors propagate → 503.
     */
    async issue(input: { email: string; password: string }): Promise<{ userId: string }> {
      const token = randomBytes(24).toString('base64url')
      const hash = sha256hex(token)
      const expiresAt = clock.now() + ttlMs
      const now = clock.now()

      const tx = await beginTx(payload)
      try {
        const user = await payload.create({
          collection: 'users',
          data: {
            email: input.email,
            password: input.password,
            role: 'teacher',
            emailConfirmationTokenHash: hash,
            emailConfirmationTokenExpiresAt: expiresAt,
          },
          req: { transactionID: tx },
          overrideAccess: true,
        })
        await payload.create({
          collection: 'email-jobs',
          data: {
            userId: user.id,
            to: input.email,
            subject: CONFIRM_SUBJECT,
            body: confirmLink(token),
            status: 'pending',
            attempts: 0,
            createdAt: now,
          },
          req: { transactionID: tx },
          overrideAccess: true,
        })
        await payload.db.commitTransaction(tx)
        return { userId: user.id as string }
      } catch (err) {
        await payload.db.rollbackTransaction(tx)
        throw err
      }
    },

    /**
     * Regenerate a confirmation token for an existing unconfirmed user and
     * queue a fresh email-job. Used by `/api/auth/resend`. Returns false (no
     * such unconfirmed user) so the caller can return a generic 200 without
     * leaking which emails are registered.
     */
    async resend(email: string): Promise<boolean> {
      const found = await payload.find({
        collection: 'users',
        where: { email: { equals: email }, emailConfirmed: { equals: false } },
        limit: 1,
        overrideAccess: true,
      })
      const user = found.docs[0] as { id: string; email: string } | undefined
      if (!user) return false
      await issueCredential(user.id, user.email)
      return true
    },

    /**
     * Consume a confirmation token. Atomic conditional update-by-where on
     * (hash, !confirmed, !expired); single-use (the update nulls the hash).
     *
     * Deterministic under concurrency: a WriteConflict / TransientTransaction
     * error is retried up to 3 times. By the retry, the winner has nulled the
     * hash, so the loser matches zero docs → 'invalid'. Result is always
     * exactly one 'ok' (the winner) and 'invalid' for every loser — never a
     * thrown error leaking the race to the client as 503.
     *
     * Returns 'ok' on match, 'invalid' for any non-match (wrong/expired/
     * replayed/unknown — collapsed for anti-enumeration). Real infrastructure
     * errors throw → caller surfaces 503.
     */
    async confirm(rawToken: string): Promise<ConfirmResult> {
      const hash = sha256hex(rawToken)
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const updated = await payload.update({
            collection: 'users',
            where: {
              emailConfirmationTokenHash: { equals: hash },
              emailConfirmed: { equals: false },
              emailConfirmationTokenExpiresAt: { greater_than: clock.now() },
            },
            data: {
              emailConfirmed: true,
              emailConfirmationTokenHash: null,
              emailConfirmationTokenExpiresAt: null,
            },
            overrideAccess: true,
          })
          return updated.docs.length > 0 ? 'ok' : 'invalid'
        } catch (err) {
          if (isTransientWriteConflict(err) && attempt < 3) continue
          throw err
        }
      }
      // Unreachable: the loop either returns or throws on the final attempt.
      return 'invalid'
    },
  }
}
