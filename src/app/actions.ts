'use server'

/**
 * Server actions — ECLASS-56 (Stage C), A1…A8/T1…T3/S1…S2 flows.
 *
 * Progressive-enhancement forms (no client JS required): every action runs
 * server-side against the SAME services the JSON API uses, sets/clears the
 * opaque session cookie, then redirects. Identity comes only from the session
 * cookie (getPageActor / resolveActor) — never from form fields.
 */
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { createSessionAdapter, issueSession } from '@/auth/session-adapter'
import { resolveActor } from '@/auth/payload-resolver'
import { createEmailConfirm } from '@/auth/email-confirm'
import { createPasswordReset } from '@/auth/password-reset'
import { SESSION_TTL_MS } from '@/auth/session-ttl'
import { isEmailConfigured } from '@/email/transport'
import { createAtomicJoin } from '@/classes/atomic-join'
import { getClassServices } from '@/classes/server'
import { getPageActor, SESSION_COOKIE } from '@/auth/server'
import { getStudentWorkspaceService } from '@/students/server'

const HOUR_MS = 60 * 60 * 1000
const CONFIRM_TOKEN_TTL_MS = 24 * HOUR_MS

const cookieOptions = (maxAgeMs: number) => ({
  httpOnly: true as const,
  secure: true as const,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: Math.floor(maxAgeMs / 1000),
})

/**
 * typedRoutes (see next.config.ts) narrows redirect() to a static route type;
 * dynamically composed URLs with query strings are still valid runtime
 * destinations, so they go through this single explicit cast.
 */
const go = (url: string): Parameters<typeof redirect>[0] => url as Parameters<typeof redirect>[0]

export async function loginAction(fd: FormData) {
  const email = String(fd.get('email') ?? '').trim()
  const password = String(fd.get('password') ?? '')
  const payload = await getPayload({ config })
  const adapter = createSessionAdapter({
    payload,
    clock: { now: () => Date.now() },
    sessionTtlMs: SESSION_TTL_MS,
  })

  let result: Awaited<ReturnType<typeof adapter.login>>
  try {
    result = await adapter.login({ email, password })
  } catch {
    redirect('/login?error=error')
  }
  if (!result.ok) redirect(go(`/login?error=${result.code}`))

  const actor = await resolveActor(payload, result.sessionId, { now: () => Date.now() })
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, result.sessionId, cookieOptions(result.cookie.maxAgeMs))
  redirect(actor?.role === 'student' ? '/student' : '/teacher')
}

export async function logoutAction() {
  const payload = await getPayload({ config })
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value
  if (sessionId) {
    const adapter = createSessionAdapter({
      payload,
      clock: { now: () => Date.now() },
      sessionTtlMs: SESSION_TTL_MS,
    })
    try {
      await adapter.logout(sessionId)
    } catch {
      // Session already gone — clearing the cookie is still correct.
    }
  }
  cookieStore.delete(SESSION_COOKIE)
  redirect('/')
}

export async function signupAction(fd: FormData) {
  const email = String(fd.get('email') ?? '').trim()
  const password = String(fd.get('password') ?? '')
  if (!email || password.length < 8) redirect('/signup?error=validation_error')
  if (!isEmailConfigured()) redirect('/signup?error=email_not_configured')

  const payload = await getPayload({ config })
  const emailConfirm = createEmailConfirm({
    payload,
    clock: { now: () => Date.now() },
    ttlMs: CONFIRM_TOKEN_TTL_MS,
  })
  try {
    await emailConfirm.issue({ email, password })
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 400) redirect(go('/signup?error=conflict&email=' + encodeURIComponent(email)))
    redirect('/signup?error=error')
  }
  redirect(go('/signup/pending?email=' + encodeURIComponent(email)))
}

export async function resendConfirmAction(fd: FormData) {
  const email = String(fd.get('email') ?? '').trim()
  if (!email) redirect('/login')
  if (!isEmailConfigured())
    redirect(go('/signup/pending?email=' + encodeURIComponent(email) + '&error=email_not_configured'))

  const payload = await getPayload({ config })
  const emailConfirm = createEmailConfirm({
    payload,
    clock: { now: () => Date.now() },
    ttlMs: CONFIRM_TOKEN_TTL_MS,
  })
  // Generic outcome either way — no email enumeration through resend.
  try {
    await emailConfirm.resend(email)
  } catch {
    // fall through to the same page; resend failure is not user-actionable
  }
  redirect(go('/signup/pending?email=' + encodeURIComponent(email) + '&resent=1'))
}

export async function joinAction(fd: FormData) {
  const code = String(fd.get('code') ?? '').trim()
  const login = String(fd.get('login') ?? '').trim()
  const displayName = String(fd.get('displayName') ?? '').trim()
  const password = String(fd.get('password') ?? '')
  const payload = await getPayload({ config })
  const join = createAtomicJoin({ payload, clock: { now: () => Date.now() } })

  let result: Awaited<ReturnType<typeof join.acceptInviteAndCreateStudent>>
  try {
    result = await join.acceptInviteAndCreateStudent({ code, login, displayName, password })
  } catch {
    redirect(go(`/join?code=${encodeURIComponent(code)}&error=error`))
  }
  if (!result.ok) {
    redirect(go(`/join?code=${encodeURIComponent(code)}&error=${result.code}&login=${encodeURIComponent(login)}`))
  }

  const session = await issueSession(
    payload,
    { id: result.studentId, role: 'student' },
    { now: () => Date.now() },
    SESSION_TTL_MS,
  )
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, session.sessionId, cookieOptions(session.cookie.maxAgeMs))
  redirect('/student')
}

export async function createClassAction(fd: FormData) {
  const actor = await getPageActor()
  if (!actor || actor.role !== 'teacher') redirect('/login?notice=auth')

  const name = String(fd.get('name') ?? '').trim()
  const subjectVersionId = String(fd.get('subjectVersionId') ?? '')
  if (!name) redirect('/teacher/classes/new?error=validation_error')
  // subjectVersionId catalog membership is enforced by the CLASS SERVICE —
  // one rule for the API route and this UI action (review finding #3).

  const payload = await getPayload({ config })
  const { classService } = getClassServices(payload)
  const result = await classService.createClass({ actor, name, subjectVersionId })
  if (!result.ok) redirect(go('/teacher/classes/new?error=' + result.code))
  redirect(go(`/teacher/classes/${result.class.id}`))
}

export async function createInviteAction(fd: FormData) {
  const actor = await getPageActor()
  if (!actor || actor.role !== 'teacher') redirect('/login?notice=auth')
  const classId = String(fd.get('classId') ?? '')

  const payload = await getPayload({ config })
  const { inviteService } = getClassServices(payload)
  const result = await inviteService.createInvite(actor, classId)
  if (!result.ok) redirect(go(`/teacher/classes/${classId}?error=${result.code}`))
  redirect(go(`/teacher/classes/${classId}?invite=${result.code}`))
}

export async function renameClassAction(fd: FormData) {
  const actor = await getPageActor()
  if (!actor || actor.role !== 'teacher') redirect('/login?notice=auth')
  const classId = String(fd.get('classId') ?? '')
  const name = String(fd.get('name') ?? '').trim()
  if (!name) redirect(go(`/teacher/classes/${classId}?error=validation_error`))

  const payload = await getPayload({ config })
  const { classService } = getClassServices(payload)
  const result = await classService.renameClass(actor, classId, name)
  if (!result.ok) redirect(go(`/teacher/classes/${classId}?error=${result.code}`))
  redirect(go(`/teacher/classes/${classId}`))
}

export async function archiveClassAction(fd: FormData) {
  const actor = await getPageActor()
  if (!actor || actor.role !== 'teacher') redirect('/login?notice=auth')
  const classId = String(fd.get('classId') ?? '')

  const payload = await getPayload({ config })
  const { classService } = getClassServices(payload)
  const result = await classService.archiveClass(actor, classId)
  if (!result.ok) redirect(go(`/teacher/classes/${classId}?error=${result.code}`))
  redirect('/teacher')
}

/**
 * A5 — password reset request (ECLASS-69). Always the same redirect: the page
 * must not reveal whether the email is registered.
 */
export async function requestPasswordResetAction(fd: FormData) {
  const email = String(fd.get('email') ?? '').trim()
  if (!email) redirect('/login')

  const payload = await getPayload({ config })
  const service = createPasswordReset({
    payload,
    clock: { now: () => Date.now() },
    ttlMs: 60 * 60 * 1000,
  })
  if (isEmailConfigured()) {
    try {
      await service.request(email)
    } catch {
      // Generic outcome — no enumeration through the redirect either.
    }
  }
  redirect(go('/reset/pending?email=' + encodeURIComponent(email)))
}

/** A5 confirm: consume the one-time token, set the new password, back to A2. */
export async function confirmPasswordResetAction(fd: FormData) {
  const token = String(fd.get('token') ?? '')
  const password = String(fd.get('password') ?? '')
  if (!token || password.length < 8) {
    redirect(go(`/reset/confirm?token=${encodeURIComponent(token)}&error=validation_error`))
  }

  const payload = await getPayload({ config })
  const service = createPasswordReset({
    payload,
    clock: { now: () => Date.now() },
    ttlMs: 60 * 60 * 1000,
  })
  let result: 'ok' | 'invalid'
  try {
    result = await service.confirm(token, password)
  } catch {
    redirect(go(`/reset/confirm?token=${encodeURIComponent(token)}&error=error`))
  }
  if (result !== 'ok') {
    redirect(go(`/reset/confirm?token=${encodeURIComponent(token)}&error=invalid_or_expired`))
  }
  redirect(go('/login?notice=reset'))
}

/**
 * A8 — the ONLY self-service profile field a student may change. Class,
 * subject and membership are not part of the input shape, so they cannot be
 * changed here by construction (ECLASS-16).
 */
export async function updateDisplayNameAction(fd: FormData) {
  const actor = await getPageActor()
  if (!actor || actor.role !== 'student') redirect('/login')
  const displayName = String(fd.get('displayName') ?? '').trim()

  const svc = await getStudentWorkspaceService()
  const result = await svc.updateProfile(actor.id, { displayName })
  if (!result.ok) redirect('/student?error=profile')
  redirect('/student')
}
