import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'
import { getClassServices } from '@/classes/server'

/**
 * /api/classes handlers — ECLASS-56 (Stage A).
 *
 * POST   → create a class (teacher only; subjectVersionId must be a known
 *          catalog entry — no free-text subjects).
 * GET    → list the caller's classes (archived excluded unless
 *          ?includeArchived=true).
 *
 * The Actor comes ONLY from the eclass_session cookie. Cross-tenant callers
 * get 404 for anything they do not own (existence must not leak).
 */
export async function handleCreateClass(req: NextRequest, payload: Payload) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  if (actor.role !== 'teacher') {
    return NextResponse.json({ ok: false, code: 'forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as
    | { name?: string; subjectVersionId?: string }
    | null
  if (!body?.name?.trim() || !body.subjectVersionId) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  const { classService } = getClassServices(payload)
  const result = await classService.createClass({
    actor,
    name: body.name,
    subjectVersionId: body.subjectVersionId,
  })
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code }, { status: 422 })
  }
  return NextResponse.json(
    {
      ok: true,
      class: {
        id: result.class.id,
        name: result.class.name,
        subjectVersionId: result.class.subjectVersionId,
        archivedAt: result.class.archivedAt,
      },
    },
    { status: 201 },
  )
}

export async function handleListClasses(req: NextRequest, payload: Payload) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })

  const includeArchived = new URL(req.url).searchParams.get('includeArchived') === 'true'
  const { classService } = getClassServices(payload)
  const classes = await classService.listClasses(actor.id, { includeArchived })
  return NextResponse.json({
    ok: true,
    items: classes.map((c) => ({
      id: c.id,
      name: c.name,
      subjectVersionId: c.subjectVersionId,
      archivedAt: c.archivedAt,
    })),
  })
}
