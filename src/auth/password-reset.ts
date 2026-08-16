/**
 * Password reset — ECLASS-69 (TDD-P1-10), Figma A5.
 *
 * Flow: A2 Login → A5 request → (sealed outbox email) → confirm → back to A2
 * with a new password and every prior session revoked.
 *
 * Security shape (mirrors the hardened ECLASS-67/68 confirm flow):
 *   - request(email): job-first — the SEALED email-job is created before the
 *     user's hash is set; on update failure the job is compensating-deleted,
 *     so no undeliverable token is ever left queued. Returns false for
 *     unknown/unconfirmed users; the ROUTE answers the same shape either way
 *     (anti-enumeration) and burns comparable CPU for both (timing).
 *   - confirm(token, newPassword): the token is claimed by a single ATOMIC
 *     findOneAndUpdate that clears the hash (single-use) AND returns the user
 *     id. Only then does the password change go through the Payload Local API
 *     (its field hooks hash the password — a raw update would store
 *     plaintext), and every session of the user is revoked. Replay/expired/
 *     forged → 'invalid'.
 *   - the RAW token exists only in memory and inside the sealed email body.
 */
import type { Collection } from 'mongodb'
import type { Payload } from 'payload'
import { randomBytes, createHash } from 'node:crypto'
import { sealEmailBody } from '@/email/crypto'

export interface Clock {
  now(): number
}

export type ResetConfirmResult = 'ok' | 'invalid'

export interface PasswordResetOptions {
  payload: Payload
  clock: Clock
  ttlMs: number
}

const sha256hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

const RESET_SUBJECT = 'Восстановление доступа'
const resetLink = (token: string) => `/reset/confirm?token=${token}`

export function createPasswordReset(opts: PasswordResetOptions) {
  const { payload, clock, ttlMs } = opts

  return {
    /**
     * Queue a reset email for a confirmed user. False when there is nothing
     * to do (unknown email / unconfirmed) — the route shapes the response
     * identically either way.
     */
    async request(email: string): Promise<boolean> {
      const found = await payload.find({
        collection: 'users',
        where: { email: { equals: email.toLowerCase() }, emailConfirmed: { equals: true } },
        limit: 1,
        overrideAccess: true,
        depth: 0,
      })
      const user = found.docs[0] as { id: string; email: string } | undefined
      if (!user) return false

      const token = randomBytes(24).toString('base64url')
      const hash = sha256hex(token)
      const expiresAt = clock.now() + ttlMs
      const now = clock.now()

      // Job-first (ECLASS-68 pattern): if the user update fails, the job is
      // compensating-deleted and any PREVIOUS pending reset stays valid.
      let job: { id: string } | undefined
      try {
        job = (await payload.create({
          collection: 'email-jobs',
          data: {
            userId: user.id,
            to: user.email,
            subject: RESET_SUBJECT,
            body: sealEmailBody(resetLink(token)),
            status: 'pending',
            attempts: 0,
            createdAt: now,
          },
          overrideAccess: true,
        })) as unknown as { id: string }
        await payload.update({
          collection: 'users',
          id: user.id,
          data: { passwordResetTokenHash: hash, passwordResetTokenExpiresAt: expiresAt },
          overrideAccess: true,
        })
      } catch (err) {
        if (job) {
          try {
            await payload.delete({ collection: 'email-jobs', id: job.id, overrideAccess: true })
          } catch (cleanupErr) {
            console.error('[password-reset] compensating job delete FAILED:', cleanupErr)
          }
        }
        throw err
      }
      return true
    },

    /**
     * Consume a reset token and set the new password. Single-use by the atomic
     * claim; revokes ALL of the user's sessions (a reset means "not me or an
     * emergency" — no old device keeps access). 'invalid' for wrong/expired/
     * replayed tokens; infrastructure errors throw (route → 503).
     */
    async confirm(rawToken: string, newPassword: string): Promise<ResetConfirmResult> {
      if (!rawToken || !newPassword || newPassword.length < 8) return 'invalid'

      const hash = sha256hex(rawToken)
      const users = payload.db.connection.collection('users') as unknown as Collection<{
        _id: unknown
        passwordResetTokenHash?: string | null
        passwordResetTokenExpiresAt?: number | null
      }>

      // ATOMIC claim: exactly one caller matches (hash, unexpired); the claim
      // clears the hash AND hands back the user id in the same operation.
      const claimed = await users.findOneAndUpdate(
        {
          passwordResetTokenHash: hash,
          passwordResetTokenExpiresAt: { $gt: clock.now() },
        },
        {
          $set: {
            passwordResetTokenHash: null,
            passwordResetTokenExpiresAt: null,
            updatedAt: new Date(),
          },
        },
        { projection: { _id: 1 }, returnDocument: 'after' as const },
      )
      const userId = claimed?._id ? String(claimed._id) : null
      if (!userId) return 'invalid'

      // The password write goes through the Payload Local API so the auth
      // field hooks hash it — a raw update would store plaintext.
      await payload.update({
        collection: 'users',
        id: userId,
        data: { password: newPassword },
        overrideAccess: true,
      })

      // Revoke every session of the user.
      const sessions = await payload.find({
        collection: 'sessions',
        where: { userId: { equals: userId } },
        limit: 200,
        overrideAccess: true,
        depth: 0,
      })
      for (const s of sessions.docs) {
        await payload.update({
          collection: 'sessions',
          id: s.id,
          data: { revoked: true },
          overrideAccess: true,
        })
      }

      return 'ok'
    },
  }
}
