import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { createSessionAdapter } from '@/auth/session-adapter'

/**
 * Login route handler — ECLASS-56 / ECLASS-65.
 *
 * Lives outside route.ts so that route.ts exports ONLY the Next.js HTTP-method
 * symbol (POST); Next.js forbids any other named export from a route file. The
 * handler is parametrised on the Payload instance so the route-boundary test
 * can inject a fault-injecting Proxy (real handler, real
 * NextRequest/NextResponse, no global mutation).
 *
 * Error surface:
 *   - validation_error (422): missing email/password.
 *   - invalid_credentials (401): wrong password / unknown user / blocked user.
 *   - email_not_confirmed (403): signup done, email not yet confirmed.
 *   - error (503): infrastructure failure (DB/network) re-thrown by the adapter
 *     — surfaced as 5xx, NOT masked as 401 (blocker 3, ECLASS-65 audit).
 */
const HOUR_MS = 60 * 60 * 1000

export async function handleLogin(req: NextRequest, payload: Payload) {
  const body = await req.json().catch(() => null)
  if (!body?.email || !body?.password) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  const adapter = createSessionAdapter({
    payload,
    clock: { now: () => Date.now() },
    sessionTtlMs: HOUR_MS,
  })

  // adapter.login returns LoginError for auth/confirmation failures but
  // RE-THROWS infrastructure errors (blocker 3). Catch those here → 5xx.
  let result
  try {
    result = await adapter.login({ email: body.email, password: body.password })
  } catch {
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }

  if (!result.ok) {
    // invalid_credentials → 401; email_not_confirmed → 403.
    const status = result.code === 'invalid_credentials' ? 401 : 403
    return NextResponse.json({ ok: false, code: result.code }, { status })
  }

  const res = NextResponse.json({ ok: true, userId: result.userId })
  res.cookies.set('eclass_session', result.sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: Math.floor(result.cookie.maxAgeMs / 1000),
    path: '/',
  })
  return res
}
