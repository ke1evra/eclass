import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { createAtomicJoin, type JoinErrorCode } from '@/classes/atomic-join'
import { issueSession } from '@/auth/session-adapter'

/**
 * POST /api/join — ECLASS-56 (Stage B) / ECLASS-57 / ECLASS-15.
 *
 * The A7 student entry point: { code, login, displayName, password } →
 * transactional (invite claim + student account + membership) → session cookie
 * → S1. The invite code is the ONLY trust anchor — students never pass a
 * classId or teacher identity, and the account is created with role 'student'
 * by the trusted server path (never client-writable).
 *
 * Error codes are invite-scoped and safe: invite_invalid (404) never confirms
 * the code exists; expired/revoked (410) carry a recovery hint; used/conflict
 * (409) tell the student to ask the teacher for a fresh code.
 */
const HOUR_MS = 60 * 60 * 1000

const joinStatus = (code: JoinErrorCode): number => {
  switch (code) {
    case 'validation_error':
      return 422
    case 'invite_invalid':
      return 404
    case 'invite_expired':
    case 'invite_revoked':
      return 410
    case 'invite_used':
    case 'already_member':
    case 'conflict':
      return 409
    default:
      return 503
  }
}

export async function handleJoin(req: NextRequest, payload: Payload) {
  const body = (await req.json().catch(() => null)) as
    | { code?: string; login?: string; displayName?: string; password?: string }
    | null

  const join = createAtomicJoin({ payload, clock: { now: () => Date.now() } })
  let result
  try {
    result = await join.acceptInviteAndCreateStudent({
      code: body?.code ?? '',
      login: body?.login ?? '',
      displayName: body?.displayName ?? '',
      password: body?.password ?? '',
    })
  } catch {
    return NextResponse.json({ ok: false, code: 'error' }, { status: 503 })
  }

  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code }, { status: joinStatus(result.code) })
  }

  const session = await issueSession(
    payload,
    { id: result.studentId, role: 'student' },
    { now: () => Date.now() },
    30 * 24 * HOUR_MS,
  )

  const res = NextResponse.json({ ok: true, classId: result.classId, studentId: result.studentId })
  res.cookies.set('eclass_session', session.sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: Math.floor(session.cookie.maxAgeMs / 1000),
    path: '/',
  })
  return res
}
