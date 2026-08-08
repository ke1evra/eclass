import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { createEmailConfirm } from '@/auth/email-confirm'

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
  } catch {
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }
}
