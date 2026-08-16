import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { createEmailConfirm } from '@/auth/email-confirm'
import { CONFIRM_RATE, enforceRateLimit } from '@/auth/rate-limit'

/**
 * Confirm route handler — ECLASS-67. Split out of route.ts so route.ts exports
 * ONLY the Next.js POST symbol; the payload parameter is the testable seam for
 * the DB-error route-boundary test (same pattern as login/handler.ts).
 *
 * See confirm/route.ts for the contract (token in, 200/400/503 out).
 */
const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export async function handleConfirm(req: NextRequest, payload: Payload) {
  const body = (await req.json().catch(() => null)) as { token?: string } | null
  if (!body?.token) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  // Confirm consumes tokens — meter per source AND per candidate token
  // (hashed into the key; each token is unique so legit retries stay clean)
  // (ECLASS-59), fail-closed.
  let limited: Response | null
  try {
    limited = await enforceRateLimit({
      payload,
      headers: req.headers,
      bucket: 'confirm',
      policy: CONFIRM_RATE,
      account: body.token,
    })
  } catch {
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }
  if (limited) return limited

  const emailConfirm = createEmailConfirm({
    payload,
    clock: { now: () => Date.now() },
    ttlMs: CONFIRM_TOKEN_TTL_MS,
  })

  try {
    const result = await emailConfirm.confirm(body.token)
    if (result === 'ok') {
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ ok: false, code: 'invalid_or_expired' }, { status: 400 })
  } catch (err) {
    // Infrastructure failure — log for operators, never to the client.
    console.error('[confirm] infrastructure error:', err)
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }
}
