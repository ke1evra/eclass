import { NextRequest, NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { createEmailConfirm } from '@/auth/email-confirm'
import { enforceRateLimit, RESEND_RATE } from '@/auth/rate-limit'
import { isEmailConfigured } from '@/email/transport'

/**
 * POST /api/auth/resend — ECLASS-67.
 *
 * Regenerates a confirmation token for an existing unconfirmed user and queues
 * a fresh `email-jobs` row (the worker delivers it). Always returns 200 so an
 * attacker cannot enumerate which emails are registered — the response is
 * identical whether the email belongs to an unconfirmed user, a confirmed
 * user, or no user at all.
 *
 * This is the recovery path when the original confirmation email was lost
 * (worker failure, expired token, user typo in the address). It does NOT
 * create users and does NOT reveal existence.
 */
const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: string } | null
  if (!body?.email) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  // Same gate as signup: refuse if no delivery path is wired, but return the
  // generic 200 body shape to avoid leaking the configuration state either.
  if (!isEmailConfigured()) {
    return NextResponse.json({ ok: true })
  }

  const payload = await getPayload({ config })

  // Resend mints fresh bearer tokens — meter it harder than login (ECLASS-59).
  // Unlike login/signup, a limiter failure must NOT change the response shape
  // (enumeration), so the fail-closed path is the generic 200-without-send.
  try {
    const limited = await enforceRateLimit({
      payload,
      headers: req.headers,
      bucket: 'resend',
      policy: RESEND_RATE,
      account: body.email,
    })
    if (limited) return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true })
  }

  const emailConfirm = createEmailConfirm({
    payload,
    clock: { now: () => Date.now() },
    ttlMs: CONFIRM_TOKEN_TTL_MS,
  })

  try {
    await emailConfirm.resend(body.email)
  } catch {
    // Swallow infra errors into the generic 200 — the endpoint must not leak.
  }
  return NextResponse.json({ ok: true })
}
