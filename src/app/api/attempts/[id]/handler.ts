import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'
import { createAttemptsService } from '@/attempts/service'

/**
 * Attempt boundary routes — ECLASS-27/28/29/33/34/35.
 *
 * GET                 → student view (questions WITHOUT answerKey) / teacher
 *                       full view, by role; 404 for anyone else.
 * POST ?action=answer → student autosave (stale clientVersion loses silently).
 * POST ?action=submit → idempotent submit + server-side autograde.
 * POST ?action=score  → teacher rubric scoring (owner-only).
 * POST ?action=finalize → teacher finalize (checked, totals frozen).
 * POST ?action=comment → feedback thread (internal notes teacher-only).
 */
const status = (code: string): number => {
  switch (code) {
    case 'not_found': return 404
    case 'forbidden': return 403
    case 'already_submitted': return 409
    case 'invalid_transition': return 409
    case 'validation_error': return 422
    default: return 400
  }
}

export async function handleGetAttempt(req: NextRequest, payload: Payload, id: string) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  const svc = createAttemptsService(payload)

  if (actor.role === 'student') {
    const view = await svc.studentView(actor, id)
    if (!view.ok) return NextResponse.json({ ok: false, code: view.code }, { status: status(view.code) })
    return NextResponse.json(view)
  }
  if (actor.role === 'teacher') {
    const view = await svc.teacherView(actor, id)
    if (!view.ok) return NextResponse.json({ ok: false, code: view.code }, { status: status(view.code) })
    // Response shape: attempt + snapshot WITH answerKey + scores + comments.
    return NextResponse.json({
      ok: true,
      attempt: view.attempt,
      questions: view.snapshot,
      studentAnswers: view.studentAnswers,
      comments: (view.attempt.comments ?? []).filter((c) => !(c.internal && false)),
    })
  }
  return NextResponse.json({ ok: false, code: 'forbidden' }, { status: 403 })
}

export async function handleAttemptAction(req: NextRequest, payload: Payload, id: string) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  const action = new URL(req.url).searchParams.get('action')
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const svc = createAttemptsService(payload)

  let result: { ok: boolean; code?: string } & Record<string, unknown>
  switch (action) {
    case 'answer':
      result = await svc.saveAnswer(actor, id, {
        code: String(body.code ?? ''),
        value: body.value,
        attachmentIds: Array.isArray(body.attachmentIds) ? (body.attachmentIds as string[]) : undefined,
        clientVersion: Number(body.clientVersion ?? 1),
      })
      break
    case 'submit':
      result = await svc.submit(actor, id, String(body.idempotencyKey ?? ''))
      break
    case 'score':
      result = await svc.score(actor, id, {
        code: String(body.code ?? ''),
        manual: Number(body.manual ?? -1),
        teacherComment: body.teacherComment ? String(body.teacherComment) : undefined,
      })
      break
    case 'finalize':
      result = await svc.finalize(actor, id)
      break
    case 'comment':
      result = await svc.addComment(actor, id, {
        body: String(body.body ?? ''),
        internal: Boolean(body.internal),
      })
      break
    default:
      return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code }, { status: status(result.code ?? 'error') })
  }
  return NextResponse.json(result)
}
