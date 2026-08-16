import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'
import { classStatus, getClassServices } from '@/classes/server'

/**
 * /api/classes/[id]/members — ECLASS-56 (Stage A) / ECLASS-14.
 *
 * GET → the roster (owner only). Student ids are resolved to display names
 * server-side; a teacher never sees another teacher's roster (not_found, 404).
 * Only the minimum roster shape crosses the wire: id + displayName.
 */
export async function handleGetMembers(req: NextRequest, payload: Payload, id: string) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })

  const { classService } = getClassServices(payload)
  const roster = await classService.getRoster(actor, id)
  if (!roster.ok) {
    return NextResponse.json({ ok: false, code: roster.code }, { status: classStatus(roster.code) })
  }

  const users = await payload.find({
    collection: 'users',
    where: { id: { in: roster.studentIds } },
    limit: 200,
    overrideAccess: true,
    depth: 0,
  })

  return NextResponse.json({
    ok: true,
    items: users.docs.map((u) => ({ id: u.id, displayName: (u as { name?: string }).name ?? '' })),
  })
}
