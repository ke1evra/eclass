import { NextRequest, NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'

/**
 * POST /api/auth/signup — ECLASS-56 / ECLASS-65.
 *
 * Creates a teacher user (role is forced server-side by the beforeChange hook;
 * any client-supplied role is ignored). The response contains ONLY
 * { ok, userId } — no hash, no password, no JWT.
 *
 * Email confirmation is required before login (ADR-0007 flow).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: string; password?: string } | null
  if (!body?.email || !body?.password || body.password.length < 8) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  const payload = await getPayload({ config })

  try {
    const user = await payload.create({
      collection: 'users',
      data: { email: body.email, password: body.password, role: 'teacher' },
      overrideAccess: true,
      draft: false,
    })
    return NextResponse.json({ ok: true, userId: user.id })
  } catch (err) {
    const msg = String(err)
    if (/already registered|duplicate/i.test(msg)) {
      return NextResponse.json({ ok: false, code: 'conflict' }, { status: 409 })
    }
    return NextResponse.json({ ok: false, code: 'error' }, { status: 500 })
  }
}
