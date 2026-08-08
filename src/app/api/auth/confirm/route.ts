import { NextRequest, NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'

/**
 * POST /api/auth/confirm — ECLASS-65 block 2 (STUB).
 *
 * ⚠ INSECURE STUB: confirms email by { userId } with NO token. Any caller who
 * knows a userId can flip that user's `emailConfirmed` to true. This exists
 * solely so the `signup → confirm → login` flow is exercisable through real
 * route handlers (audit requirement, ECLASS-65). It MUST NOT ship to a
 * production-facing environment as-is.
 *
 * TODO(ECLASS-NN, real email-token flow):
 *   - add `emailConfirmationToken` field to Users, generated at signup;
 *   - this handler verifies the token, sets emailConfirmed=true, and
 *     single-use-invalidates the token;
 *   - signup sends the confirmation link via email (out-of-band).
 *
 * `emailConfirmed` has admin-only field-level update access (Users.ts); the
 * beforeChange hook permits the change on the trusted server path (no
 * req.user), so the update goes through with overrideAccess: true.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { userId?: string } | null
  if (!body?.userId) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  const payload = await getPayload({ config })
  try {
    await payload.update({
      collection: 'users',
      id: body.userId,
      data: { emailConfirmed: true },
      overrideAccess: true,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    const status = (err as { status?: number })?.status
    if (status === 404) {
      return NextResponse.json({ ok: false, code: 'not_found' }, { status: 404 })
    }
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }
}
