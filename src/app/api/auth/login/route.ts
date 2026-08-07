import { NextRequest, NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { createSessionAdapter } from '@/auth/session-adapter'

/**
 * POST /api/auth/login — ECLASS-56 / ECLASS-65.
 *
 * Verifies credentials via Payload (ADR-0007), creates one opaque session,
 * sets the eclass_session cookie. The response body contains ONLY { ok, userId }
 * — never the password hash, never the Payload JWT, never the session token
 * (the token goes exclusively into the httpOnly cookie).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.email || !body?.password) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  const payload = await getPayload({ config })
  const adapter = createSessionAdapter({
    payload,
    clock: { now: () => Date.now() },
    sessionTtlMs: 60 * 60 * 1000,
  })

  const result = await adapter.login({ email: body.email, password: body.password })
  if (!result.ok) {
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
