import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { createPasswordReset } from '@/auth/password-reset'
import { CONFIRM_RATE, enforceRateLimit } from '@/auth/rate-limit'

/**
 * POST /api/auth/password-reset/confirm — ECLASS-69.
 *
 * Consumes the one-time token, sets the new password through Payload (hooks
 * hash it), revokes every prior session. 200 ok / 400 invalid_or_expired
 * (wrong/expired/replayed — collapsed) / 422 short password / 503 infra.
 * Fail-closed limiter like every auth mutation.
 */
const RESET_TTL_MS = 60 * 60 * 1000

export async function handleResetConfirm(req: NextRequest, payload: Payload) {
  const body = (await req.json().catch(() => null)) as { token?: string; password?: string } | null
  if (!body?.token || !body.password) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }
  if (body.password.length < 8) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  let limited: Response | null
  try {
    limited = await enforceRateLimit({
      payload,
      headers: req.headers,
      bucket: 'pwreset-confirm',
      policy: CONFIRM_RATE,
      account: body.token,
    })
  } catch {
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }
  if (limited) return limited

  const service = createPasswordReset({
    payload,
    clock: { now: () => Date.now() },
    ttlMs: RESET_TTL_MS,
  })
  try {
    const result = await service.confirm(body.token, body.password)
    if (result === 'ok') return NextResponse.json({ ok: true })
    return NextResponse.json({ ok: false, code: 'invalid_or_expired' }, { status: 400 })
  } catch (err) {
    console.error('[password-reset] confirm infrastructure error:', err)
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }
}
