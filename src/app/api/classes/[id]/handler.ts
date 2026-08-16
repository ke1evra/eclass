import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'
import { classStatus, getClassServices } from '@/classes/server'

/**
 * /api/classes/[id] handlers — ECLASS-56 (Stage A) / ECLASS-14.
 *
 * GET   → class detail (owner only; 404 for anyone else — no existence leak).
 * PATCH → rename ({ name }) and/or archive ({ archived: true }). Archiving is
 *         soft: history survives, list excludes the class by default.
 */
const classShape = (c: { id: string; name: string; subjectVersionId: string; archivedAt: number | null }) => ({
  id: c.id,
  name: c.name,
  subjectVersionId: c.subjectVersionId,
  archivedAt: c.archivedAt,
})

export async function handleGetClass(req: NextRequest, payload: Payload, id: string) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })

  const { classService } = getClassServices(payload)
  const result = await classService.getClass(actor, id)
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code }, { status: classStatus(result.code) })
  }
  return NextResponse.json({ ok: true, class: classShape(result.class) })
}

export async function handlePatchClass(req: NextRequest, payload: Payload, id: string) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | { name?: string; archived?: boolean }
    | null
  if (!body || (body.name === undefined && body.archived === undefined)) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }

  const { classService } = getClassServices(payload)

  if (typeof body.name === 'string') {
    const renamed = await classService.renameClass(actor, id, body.name)
    if (!renamed.ok) {
      return NextResponse.json({ ok: false, code: renamed.code }, { status: classStatus(renamed.code) })
    }
    if (body.archived !== true) {
      return NextResponse.json({ ok: true, class: classShape(renamed.class) })
    }
  }

  if (body.archived === true) {
    const archived = await classService.archiveClass(actor, id)
    if (!archived.ok) {
      return NextResponse.json({ ok: false, code: archived.code }, { status: classStatus(archived.code) })
    }
    return NextResponse.json({ ok: true, class: classShape(archived.class) })
  }

  return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
}
