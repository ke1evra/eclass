/**
 * Email confirmation factory — ECLASS-67.
 *
 * Replaces the insecure `/confirm { userId }` stub (which let anyone flip
 * `emailConfirmed` on a known userId without owning the mailbox). This module
 * implements the real token-hash flow:
 *
 *   issue(userId, email):
 *     - generate a random bearer token (raw form only in memory + the email)
 *     - persist SHA-256(token) + expiry, NEVER the raw token
 *     - send the raw token to the user's email via the injectable transport
 *
 *   confirm(rawToken):
 *     - atomic conditional update-by-where on (hash, !confirmed, !expired)
 *     - single-use: the update nulls the hash, so a replay matches zero docs
 *     - returns 'ok' or 'invalid' (deliberately collapses invalid / expired /
 *       already-used to one code — anti-enumeration)
 *
 * Infrastructure errors propagate (caller surfaces them as 5xx); only the
 * "no matching doc" outcome is treated as a user-facing 'invalid'.
 */
import type { Payload } from 'payload'
import { randomBytes, createHash } from 'node:crypto'
import type { EmailTransport } from '@/email/transport'

export interface Clock {
  now(): number
}

export interface EmailConfirmOptions {
  payload: Payload
  transport: EmailTransport
  clock: Clock
  /** Token lifetime in ms. Typically 24h. */
  ttlMs: number
}

export type ConfirmResult = 'ok' | 'invalid'

const sha256hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

export function createEmailConfirm(opts: EmailConfirmOptions) {
  const { payload, transport, clock, ttlMs } = opts

  return {
    /**
     * Generate a one-time confirmation token, persist its SHA-256 hash + an
     * expiry, and email the raw token to `email`. The raw token is NEVER
     * persisted and NEVER returned to the caller — only the transport sees it.
     */
    async issue(userId: string, email: string): Promise<void> {
      const token = randomBytes(24).toString('base64url') // ~32 chars, URL-safe
      const hash = sha256hex(token)
      const expiresAt = clock.now() + ttlMs

      await payload.update({
        collection: 'users',
        id: userId,
        data: {
          emailConfirmationTokenHash: hash,
          emailConfirmationTokenExpiresAt: expiresAt,
        },
        overrideAccess: true,
      })

      // Body carries the raw bearer token; transports MUST NOT log the body.
      await transport.send({
        to: email,
        subject: 'Confirm your email',
        body: `Confirm your email by visiting: /api/auth/confirm?token=${token}`,
      })
    },

    /**
     * Consume a confirmation token. Atomic conditional update-by-where: only a
     * row whose hash matches, that is not yet confirmed, and whose token has
     * not expired is flipped to confirmed and has its hash cleared. Concurrent
     * calls with the same token race on this single update — exactly one wins
     * (Mongo serialises the document write), the rest match zero docs.
     *
     * Returns 'ok' on a match, 'invalid' for any non-match (wrong token,
     * expired, already used, or unknown). Infrastructure errors throw so the
     * caller can surface them as 5xx rather than mislabel them as 'invalid'.
     */
    async confirm(rawToken: string): Promise<ConfirmResult> {
      const hash = sha256hex(rawToken)
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
    },
  }
}
