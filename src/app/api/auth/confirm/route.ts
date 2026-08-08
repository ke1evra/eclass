import { NextRequest, NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { createEmailConfirm } from '@/auth/email-confirm'
import { getEmailTransport } from '@/email/transport'

/**
 * POST /api/auth/confirm — ECLASS-67.
 *
 * Real token-hash flow. Accepts `{ token }` (the raw bearer token delivered
 * out-of-band via email); verifies it atomically against the stored SHA-256
 * hash + non-expiry + not-yet-confirmed, flips `emailConfirmed` to true and
 * single-use-invalidates the token by clearing its hash.
 *
 * Anti-enumeration: every failure (wrong token, expired, already used,
 * unknown) collapses to the identical `{ ok: false, code: 'invalid_or_expired' }`
 * body + 400 — no signal leaks about whether the email exists.
 *
 * Infrastructure errors surface as 503 (not masked as invalid), mirroring the
 * login handler's error taxonomy.
 */
const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { token?: string } | null
  if (!body?.token) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  const payload = await getPayload({ config })
  const emailConfirm = createEmailConfirm({
    payload,
    transport: getEmailTransport(), // unused by confirm() but required by the factory signature
    clock: { now: () => Date.now() },
    ttlMs: CONFIRM_TOKEN_TTL_MS,
  })

  try {
    const result = await emailConfirm.confirm(body.token)
    if (result === 'ok') {
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ ok: false, code: 'invalid_or_expired' }, { status: 400 })
  } catch {
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }
}
