import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { APIError } from 'payload'
import { createEmailConfirm } from '@/auth/email-confirm'
import { enforceRateLimit, SIGNUP_IP_RATE, SIGNUP_RATE } from '@/auth/rate-limit'
import { isEmailConfigured } from '@/email/transport'

/**
 * Signup route handler — ECLASS-67 (v2, outbox). Split out of route.ts so the
 * route-boundary test can inject a fault-inducing Payload Proxy (transaction
 * rollback proof). See route.ts for the full contract.
 */
const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export async function handleSignup(req: NextRequest, payload: Payload) {
  const body = (await req.json().catch(() => null)) as { email?: string; password?: string } | null
  if (!body?.email || !body?.password || body.password.length < 8) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  if (!isEmailConfigured()) {
    return NextResponse.json({ ok: false, code: 'email_not_configured' }, { status: 503 })
  }

  // Shared-store limiter (ECLASS-59), fail-closed like every auth mutation.
  let limited: Response | null
  try {
    limited = await enforceRateLimit({
      payload,
      headers: req.headers,
      bucket: 'signup',
      policy: SIGNUP_RATE,
      account: body.email,
    })
    if (!limited) {
      limited = await enforceRateLimit({
        payload,
        headers: req.headers,
        bucket: 'signup-ip',
        policy: SIGNUP_IP_RATE,
      })
    }
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
    const { userId } = await emailConfirm.issue({ email: body.email, password: body.password })
    return NextResponse.json({ ok: true, userId })
  } catch (err) {
    // E11000 duplicate email surfaces as a Payload ValidationError (status 400).
    if (err instanceof APIError && (err as { status?: number }).status === 400) {
      return NextResponse.json({ ok: false, code: 'conflict' }, { status: 409 })
    }
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }
}
