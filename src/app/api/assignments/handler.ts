import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'
import { createAndAssign, listForClass } from '@/assignments/service'

/**
 * POST /api/assignments — create + assign in one step (ECLASS-23/24).
 * Body: { classId, title, questionCodes[], recipients: 'all' | studentIds[],
 * dueAt? }. The snapshot is copied server-side; recipients are resolved
 * against the class roster (teacher-owned class only).
 */
export async function handleCreateAssignment(req: NextRequest, payload: Payload) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  if (actor.role !== 'teacher') {
    return NextResponse.json({ ok: false, code: 'forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as {
    classId?: string
    title?: string
    questionCodes?: string[]
    recipients?: 'all' | string[]
    dueAt?: number | null
    subjectVersionId?: string
  } | null
  if (!body?.classId || !body.title || !body.questionCodes?.length) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  // Class ownership + roster (ECLASS-24: explicit recipients from the roster).
  const cls = await payload.find({
    collection: 'classes',
    where: { id: { equals: body.classId } },
    limit: 1,
    overrideAccess: true,
  })
  const classDoc = cls.docs[0] as { ownerId: string; subjectVersionId: string } | undefined
  if (!classDoc || classDoc.ownerId !== actor.id) {
    return NextResponse.json({ ok: false, code: 'not_found' }, { status: 404 })
  }
  const roster = await payload.find({
    collection: 'memberships',
    where: { classId: { equals: body.classId } },
    limit: 200,
    overrideAccess: true,
  })
  const rosterIds = (roster.docs as unknown as { studentId: string }[]).map((m) => m.studentId)
  const recipientIds =
    body.recipients === 'all' ? rosterIds : (body.recipients ?? []).filter((id) => rosterIds.includes(id))
  if (recipientIds.length === 0) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  const result = await createAndAssign(payload, {
    ownerId: actor.id,
    classId: body.classId,
    title: body.title,
    questionCodes: body.questionCodes,
    recipientIds,
    dueAt: body.dueAt ?? null,
    subjectVersionId: body.subjectVersionId ?? classDoc.subjectVersionId,
  })
  if (!result.ok) {
    const status = result.code === 'question_not_found' ? 422 : 422
    return NextResponse.json({ ok: false, code: result.code }, { status })
  }
  return NextResponse.json({ ok: true, assignmentId: result.assignmentId }, { status: 201 })
}

/** GET /api/assignments?classId= — the class work list with statuses (T6). */
export async function handleListAssignments(req: NextRequest, payload: Payload) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  if (actor.role !== 'teacher') {
    return NextResponse.json({ ok: false, code: 'forbidden' }, { status: 403 })
  }
  const classId = new URL(req.url).searchParams.get('classId')
  if (!classId) return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  const items = await listForClass(payload, actor.id, classId)
  return NextResponse.json({ ok: true, items })
}
