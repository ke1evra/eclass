import { NextRequest, NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { createSessionAdapter } from '@/auth/session-adapter'

/**
 * POST /api/auth/logout — ECLASS-56 / ECLASS-65.
 * Revokes the session by its opaque cookie id and clears the cookie.
 */
export async function POST(req: NextRequest) {
  const sessionId = req.cookies.get('eclass_session')?.value
  const res = NextResponse.json({ ok: true })

  if (sessionId) {
    const payload = await getPayload({ config })
    const adapter = createSessionAdapter({
      payload,
      clock: { now: () => Date.now() },
      sessionTtlMs: 60 * 60 * 1000,
    })
    await adapter.logout(sessionId)
  }

  res.cookies.set('eclass_session', '', { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 0, path: '/' })
  return res
}
