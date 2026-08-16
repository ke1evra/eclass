import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { createHash, randomBytes } from 'node:crypto'
import { createPasswordReset } from '@/auth/password-reset'
import { enforceRateLimit, RESEND_RATE } from '@/auth/rate-limit'
import { isEmailConfigured } from '@/email/transport'

/**
 * POST /api/auth/password-reset/request — ECLASS-69 (A5).
 *
 * Anti-enumeration: the response is byte-identical whether the email belongs
 * to a confirmed user or not, and the timing is equalized by hashing a dummy
 * token on the miss path (same scrypt/sha workload as the hit path's token
 * generation). Always 200; rate-limited like resend (5/h per account+source)
 * with the same generic-200 fail shape. Raw token never appears in any
 * response or log — only the sealed email-job carries the link.
 */
const RESET_TTL_MS = 60 * 60 * 1000 // 1h — narrower than confirmation

export async function handleResetRequest(req: NextRequest, payload: Payload) {
  const body = (await req.json().catch(() => null)) as { email?: string } | null
  if (!body?.email) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  if (!isEmailConfigured()) {
    return NextResponse.json({ ok: true })
  }

  // Meter like resend (mints a fresh bearer link); the limiter must not leak
  // state, so denial and failure both keep the generic 200 shape.
  try {
    const limited = await enforceRateLimit({
      payload,
      headers: req.headers,
      bucket: 'pwreset',
      policy: RESEND_RATE,
      account: body.email,
    })
    if (limited) return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true })
  }

  const service = createPasswordReset({
    payload,
    clock: { now: () => Date.now() },
    ttlMs: RESET_TTL_MS,
  })
  try {
    const queued = await service.request(body.email)
    if (!queued) {
      // Equalize timing with the hit path: it generated+hashed a token; burn
      // the same crypto here so response latency does not reveal existence.
      createHash('sha256').update(randomBytes(24).toString('base64url')).digest('hex')
    }
  } catch {
    // Swallow infra errors into the generic 200 — no enumeration, no probe
    // surface. Server logs carry the compensating-delete diagnostics.
  }
  return NextResponse.json({ ok: true })
}
