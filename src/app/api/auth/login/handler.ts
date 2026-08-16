import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { createSessionAdapter } from '@/auth/session-adapter'
import { enforceRateLimit, LOGIN_IP_RATE, LOGIN_RATE } from '@/auth/rate-limit'
import { SESSION_TTL_MS } from '@/auth/session-ttl'

/**
 * Login route handler — ECLASS-56 / ECLASS-65 / ECLASS-59.
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
 *   - rate_limited (429 + Retry-After): shared sliding-window limiter
 *     (ECLASS-59); identical for known/unknown emails — no existence leak.
 *   - error (503): infrastructure failure (DB/network) re-thrown by the adapter
 *     or the fail-closed limiter — surfaced as 5xx, NOT masked as 401.
 */
export async function handleLogin(req: NextRequest, payload: Payload) {
  const body = await req.json().catch(() => null)
  if (!body?.email || !body?.password) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  // Shared-store sliding window (ECLASS-59): per-account+source AND a generous
  // source-only window against email-rotating brute force. Fail-closed: a
  // limiter failure rejects the auth mutation as 503 instead of unmetered.
  let limited: Response | null
  try {
    limited = await enforceRateLimit({
      payload,
      headers: req.headers,
      bucket: 'login',
      policy: LOGIN_RATE,
      account: body.email,
    })
    if (!limited) {
      limited = await enforceRateLimit({
        payload,
        headers: req.headers,
        bucket: 'login-ip',
        policy: LOGIN_IP_RATE,
      })
    }
  } catch {
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }
  if (limited) return limited

  const adapter = createSessionAdapter({
    payload,
    clock: { now: () => Date.now() },
    sessionTtlMs: SESSION_TTL_MS, // ONE policy for API/UI/join (ECLASS-13 review fix)
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
