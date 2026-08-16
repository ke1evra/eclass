/**
 * Email body encryption at rest — ECLASS-68 (Дополнение валидации).
 *
 * The outbox body carries a raw bearer token (the confirmation link). The
 * auditor's invariant: the raw token is NEVER stored in Mongo plaintext —
 * clearing the body after delivery is necessary but insufficient, because
 * until delivery it would sit in the open. Every body is therefore sealed
 * with AES-256-GCM at issue time and opened ONLY inside the worker for the
 * duration of the send. The transport sees plaintext; the database never does.
 *
 * Key source (in priority order):
 *   1. EMAIL_BODY_ENCRYPTION_KEY — 32 bytes, base64 or hex (64 hex chars).
 *   2. Derived from PAYLOAD_SECRET via scrypt with a fixed context salt —
 *      one less secret to rotate for a small deployment; rotating
 *      PAYLOAD_SECRET invalidates undelivered bodies (they fail delivery and
 *      the user requests a resend), which is the documented trade-off.
 *
 * Ciphertext format: `v1:<iv-b64>:<tag-b64>:<ct-b64>` — versioned so the
 * scheme can be replaced without touching un-drained rows.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const SALT = 'eclass:email-body:v1'
const KEY_LEN = 32

let cachedKey: Buffer | null = null

const resolveKey = (): Buffer => {
  if (cachedKey) return cachedKey
  const explicit = process.env.EMAIL_BODY_ENCRYPTION_KEY
  if (explicit) {
    const raw = /^[0-9a-fA-F]{64}$/.test(explicit)
      ? Buffer.from(explicit, 'hex')
      : Buffer.from(explicit, 'base64')
    if (raw.length !== KEY_LEN) {
      throw new Error('EMAIL_BODY_ENCRYPTION_KEY must decode to exactly 32 bytes')
    }
    cachedKey = raw
    return cachedKey
  }
  const secret = process.env.PAYLOAD_SECRET
  if (!secret || secret === 'insecure-p0-dev-secret-change-me') {
    // Dev/test fallback: deterministic per-process key. Bodies remain sealed
    // against casual DB reads; a production deployment MUST set one of the
    // real env vars (checked at boot in instrumentation.ts for prod).
    cachedKey = scryptSync('eclass-dev-fallback', SALT, KEY_LEN)
    return cachedKey
  }
  cachedKey = scryptSync(secret, SALT, KEY_LEN)
  return cachedKey
}

/** Test seam: clear the cached key after env changes. */
export const resetEmailBodyKeyCache = (): void => {
  cachedKey = null
}

export const isSealed = (value: string | null | undefined): boolean =>
  typeof value === 'string' && value.startsWith('v1:')

export function sealEmailBody(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, resolveKey(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

export function openEmailBody(sealed: string): string {
  const parts = sealed.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('malformed sealed body')
  }
  const [, ivB64, tagB64, ctB64] = parts
  try {
    const decipher = createDecipheriv(ALGO, resolveKey(), Buffer.from(ivB64!, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64!, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    // A failed open (wrong key / tampered row) must never surface ciphertext.
    throw new Error('sealed body failed authentication')
  }
}
