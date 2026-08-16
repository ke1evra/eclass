/**
 * Email confirmation factory — ECLASS-67 (v2, outbox-pattern).
 *
 * v1 had a non-atomic signup: create user → persist hash → call transport. If
 * the hash write or transport call failed, the user was already created, the
 * raw token was lost forever, and a duplicate-email conflict blocked the retry.
 * v2 fixes this with an outbox + compensating-delete pattern:
 *
 *   issue({email, password}):
 *     - generate raw token + sha256 hash + expiry
 *     - create the user (with hash+expiry baked in)
 *     - write a pending `email-jobs` row whose body carries the raw token
 *     - if the email-job write fails, DELETE the just-created user
 *       (compensating action): the email is free for a clean retry, no raw
 *       token is orphaned, no half-state persists
 *     - the transport is NEVER called here; a background worker drains the
 *       outbox separately (email delivery cannot be rolled back, so it must
 *       be decoupled from the user/job write)
 *
 *   resend({email}):
 *     - find the unconfirmed user by email; if none, return false (caller
 *       surfaces a generic 200 to avoid email enumeration)
 *     - regenerate a fresh token/hash/expiry, update the user, write a new
 *       `email-jobs` row
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

export function createEmailConfirm(opts: EmailConfirmOptions) {
  const { payload, clock, ttlMs } = opts

  /**
   * Create the user (with the confirmation hash + expiry baked in) then write
   * the pending `email-jobs` row carrying the raw token. If the email-job
   * write fails, COMPENSATE by deleting the just-created user — so the email
   * is free for a clean retry and no raw token is orphaned.
   *
   * Why not a single Mongo transaction? The Payload Local API
   * `create({ req: { transactionID } })` path is unstable on a single-node
   * replset: it times out acquiring the collection IX lock inside the
   * transaction window (`maxTimeMS`). Verified locally: beginTransaction
   * returns a UUID, but the first `create` throws MongoServerError "Unable to
   * acquire IX lock ... within 5ms". Raw MongoClient transactions work
   * (transaction.test.ts) but would bypass Payload hooks (password hashing,
   * beforeChange role-force) — unacceptable. Compensating delete gives the
   * same outward guarantee the auditor asked for (no stranded user, retry
   * clean, no lost token) without the lock-acquisition fragility.
   *
   * The transient window between user-create and email-job-create is harmless:
   * the user cannot log in (emailConfirmed=false) and the worker has no
   * pending job to deliver, so the user is effectively inert until resend.
   */
  async function issueUserWithJob(input: {
    email: string
    password: string
  }): Promise<{ userId: string }> {
    const token = randomBytes(24).toString('base64url')
    const hash = sha256hex(token)
    const expiresAt = clock.now() + ttlMs
    const now = clock.now()

    const user = await payload.create({
      collection: 'users',
      data: {
        email: input.email,
        password: input.password,
        role: 'teacher',
        emailConfirmationTokenHash: hash,
        emailConfirmationTokenExpiresAt: expiresAt,
      },
      overrideAccess: true,
    })

    try {
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
        overrideAccess: true,
      })
    } catch (err) {
      // Compensate: the user was created but the deliverable link was not.
      // Delete the user so a retry with the same email is clean (no E11000)
      // and no half-state persists. A failure here would leave a stranded
      // user — surface it to the caller as the original error.
      try {
        await payload.delete({ collection: 'users', id: user.id, overrideAccess: true })
      } catch {
        // Best-effort; the original error is the meaningful one.
      }
      throw err
    }
    return { userId: user.id as string }
  }

  return {
    /**
     * Signup-time credential issuance. Creates the user (role forced to
     * 'teacher' by the Users beforeChange hook) WITH the confirmation hash +
     * expiry, then writes a pending email-job. On email-job failure the user
     * is DELETED (compensating action) so a retry with the same email is clean
     * and no raw token is orphaned.
     *
     * Throws ValidationError (status 400, from E11000) on duplicate email —
     * the caller maps that to 409. Other errors propagate → 503.
     */
    async issue(input: { email: string; password: string }): Promise<{ userId: string }> {
      return issueUserWithJob(input)
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
      const token = randomBytes(24).toString('base64url')
      const hash = sha256hex(token)
      const expiresAt = clock.now() + ttlMs
      const now = clock.now()

      await payload.update({
        collection: 'users',
        id: user.id,
        data: { emailConfirmationTokenHash: hash, emailConfirmationTokenExpiresAt: expiresAt },
        overrideAccess: true,
      })
      await payload.create({
        collection: 'email-jobs',
        data: {
          userId: user.id,
          to: user.email,
          subject: CONFIRM_SUBJECT,
          body: confirmLink(token),
          status: 'pending',
          attempts: 0,
          createdAt: now,
        },
        overrideAccess: true,
      })
      return true
    },

    /**
     * Consume a confirmation token. SINGLE-DOCUMENT ATOMIC conditional
     * updateOne on (hash, !confirmed, !expired); single-use (the update nulls
     * the hash).
     *
     * Why a raw updateOne and NOT payload.update({ where }): db-mongodb's
     * update-by-where with a limit is find-then-update-by-ids — the where is
     * NOT re-checked inside the write. Two concurrent confirms both read the
     * still-unconfirmed doc and both "succeed" (observed as [200, 200]; the
     * concurrent-confirm integration test catches exactly this). A raw
     * conditional updateOne makes the check-and-set one atomic Mongo
     * operation: exactly one caller matches, every loser gets matchedCount 0
     * → 'invalid'.
     *
     * Payload hooks are intentionally bypassed: this write touches only the
     * confirmation fields, not role/email (the Users beforeChange hook exists
     * to freeze those for clients — a Local API call with overrideAccess is
     * the trusted server path either way).
     *
     * Returns 'ok' on match, 'invalid' for any non-match (wrong/expired/
     * replayed/unknown — collapsed for anti-enumeration). Real infrastructure
     * errors throw → caller surfaces 503.
     */
    async confirm(rawToken: string): Promise<ConfirmResult> {
      const hash = sha256hex(rawToken)
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await payload.db.connection.collection('users').updateOne(
            {
              emailConfirmationTokenHash: hash,
              emailConfirmed: false,
              emailConfirmationTokenExpiresAt: { $gt: clock.now() },
            },
            {
              $set: {
                emailConfirmed: true,
                emailConfirmationTokenHash: null,
                emailConfirmationTokenExpiresAt: null,
                updatedAt: new Date(),
              },
            },
          )
          return result.matchedCount === 1 ? 'ok' : 'invalid'
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
