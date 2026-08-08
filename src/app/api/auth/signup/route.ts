import { NextRequest, NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { createEmailConfirm } from '@/auth/email-confirm'
import { getEmailTransport } from '@/email/transport'

/**
 * POST /api/auth/signup — ECLASS-56 / ECLASS-65 / ECLASS-67.
 *
 * Creates a teacher user (role forced server-side by the beforeChange hook;
 * any client-supplied role is ignored), then issues a one-time email
 * confirmation token. The response contains ONLY { ok, userId } — no hash, no
 * password, no JWT, and crucially NO confirmation token (ECLASS-67: the token
 * is delivered exclusively via the email transport, never the response body).
 */
const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: string; password?: string } | null
  if (!body?.email || !body?.password || body.password.length < 8) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  const payload = await getPayload({ config })

  let user: { id: string; email: string }
  try {
    const created = await payload.create({
      collection: 'users',
      data: { email: body.email, password: body.password, role: 'teacher' },
      overrideAccess: true,
      draft: false,
    })
    user = created as { id: string; email: string }
  } catch (err) {
    const msg = String(err)
    if (/already registered|duplicate/i.test(msg)) {
      return NextResponse.json({ ok: false, code: 'conflict' }, { status: 409 })
    }
    return NextResponse.json({ ok: false, code: 'error' }, { status: 500 })
  }

  // Issue the confirmation token. If this fails the user is created but cannot
  // log in until confirmed — surface a 503 so the client knows to retry the
  // (idempotent) resends, rather than silently swallowing the failure.
  const emailConfirm = createEmailConfirm({
    payload,
    transport: getEmailTransport(),
    clock: { now: () => Date.now() },
    ttlMs: CONFIRM_TOKEN_TTL_MS,
  })
  try {
    await emailConfirm.issue(user.id, user.email)
  } catch {
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }

  return NextResponse.json({ ok: true, userId: user.id })
}
