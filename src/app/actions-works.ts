'use server'

/**
 * Work-flow server actions — ECLASS-23/24/26/29/33/34/35/36.
 * Same services as the JSON API; identity strictly from the session cookie.
 */
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'
import type { Actor } from '@/domain/authorization'
import config from '@/payload.config'
import { resolveActor } from '@/auth/payload-resolver'
import { getPageAuth, SESSION_COOKIE } from '@/auth/server'
import { createAndAssign } from '@/assignments/service'
import { createAttemptsService } from '@/attempts/service'

const go = (url: string): Parameters<typeof redirect>[0] => url as Parameters<typeof redirect>[0]

const actorFromCookie = async (): Promise<Actor | null> => {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value
  const payload = await getPayload({ config })
  return resolveActor(payload, sessionId, { now: () => Date.now() })
}

export async function createWorkAction(fd: FormData) {
  const { actor } = await getPageAuth()
  if (!actor || actor.role !== 'teacher') redirect('/login?notice=auth')

  const classId = String(fd.get('classId') ?? '')
  const title = String(fd.get('title') ?? '').trim()
  const subjectVersionId = String(fd.get('subjectVersionId') ?? '')
  const codes = fd.getAll('questionCodes').map(String).filter(Boolean)
  const recipients = fd.getAll('recipients').map(String).filter(Boolean)
  const dueAtRaw = String(fd.get('dueAt') ?? '').trim()
  if (!title || codes.length === 0) {
    redirect(go(`/teacher/classes/${classId}/new-work?error=validation_error`))
  }

  const payload = await getPayload({ config })
  const result = await createAndAssign(payload, {
    ownerId: actor.id,
    classId,
    title,
    questionCodes: codes,
    recipientIds: recipients,
    dueAt: dueAtRaw ? new Date(dueAtRaw).getTime() : null,
    subjectVersionId,
  })
  if (!result.ok) {
    redirect(go(`/teacher/classes/${classId}/new-work?error=${result.code}`))
  }
  redirect(go(`/teacher/classes/${classId}`))
}

export async function saveAnswerAction(fd: FormData) {
  const actor = await actorFromCookie()
  const attemptId = String(fd.get('attemptId') ?? '')
  const code = String(fd.get('code') ?? '')
  const clientVersion = Number(fd.get('clientVersion') ?? 1)
  if (!actor || actor.role !== 'student' || !attemptId || !code) return

  const payload = await getPayload({ config })
  const svc = createAttemptsService(payload)
  let value: unknown
  const kind = String(fd.get('kind') ?? 'text')
  if (kind === 'choice-multi') value = fd.getAll('value').map(String)
  else value = String(fd.get('value') ?? '')
  await svc.saveAnswer(actor, attemptId, { code, value, clientVersion })
  // PRG: без redirect DOM остаётся устаревшим (гидратированный fetch не
  // перерисовывает страницу, а no-JS ответ не ревалидирует динамические данные).
  redirect(go(`/student/work/${attemptId}`))
}

export async function submitWorkAction(fd: FormData) {
  const actor = await actorFromCookie()
  const attemptId = String(fd.get('attemptId') ?? '')
  if (!actor || actor.role !== 'student' || !attemptId) return
  const payload = await getPayload({ config })
  const svc = createAttemptsService(payload)
  await svc.submit(actor, attemptId, `ui-${Date.now()}-${attemptId}`)
  redirect(go(`/student/work/${attemptId}`))
}

export async function scoreAnswerAction(fd: FormData) {
  const { actor } = await getPageAuth()
  const attemptId = String(fd.get('attemptId') ?? '')
  if (!actor || actor.role !== 'teacher' || !attemptId) return
  const payload = await getPayload({ config })
  const svc = createAttemptsService(payload)
  await svc.score(actor, attemptId, {
    code: String(fd.get('code') ?? ''),
    manual: Number(fd.get('manual') ?? 0),
    teacherComment: String(fd.get('teacherComment') ?? '') || undefined,
  })
  redirect(go(`/teacher/review/${attemptId}`))
}

export async function finalizeWorkAction(fd: FormData) {
  const { actor } = await getPageAuth()
  const attemptId = String(fd.get('attemptId') ?? '')
  if (!actor || actor.role !== 'teacher' || !attemptId) return
  const payload = await getPayload({ config })
  const svc = createAttemptsService(payload)
  await svc.finalize(actor, attemptId)
  redirect(go(`/teacher/review/${attemptId}`))
}

export async function commentAction(fd: FormData) {
  const { actor } = await getPageAuth()
  const attemptId = String(fd.get('attemptId') ?? '')
  const body = String(fd.get('body') ?? '').trim()
  const internal = String(fd.get('internal') ?? '') === 'on'
  if (!actor || !attemptId || !body) return
  const payload = await getPayload({ config })
  const svc = createAttemptsService(payload)
  await svc.addComment(actor, attemptId, { body, internal: actor.role === 'teacher' ? internal : false })
  // Возврат на страницу автора комментария: учитель — в проверку, ученик — в работу.
  redirect(go(actor.role === 'teacher' ? `/teacher/review/${attemptId}` : `/student/work/${attemptId}`))
}

export async function remediationAction(fd: FormData) {
  const { actor } = await getPageAuth()
  const attemptId = String(fd.get('attemptId') ?? '')
  if (!actor || actor.role !== 'teacher' || !attemptId) return
  const payload = await getPayload({ config })
  const svc = createAttemptsService(payload)
  await svc.remediation(actor, attemptId, (candidates, failedTopics) =>
    candidates.filter((c) => failedTopics.includes(c.topic)).slice(0, 5).map((c) => c.code),
  )
  redirect(go(`/teacher/review/${attemptId}?remediation=created`))
}
