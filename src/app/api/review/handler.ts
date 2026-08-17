import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'
import { createAttemptsService } from '@/attempts/service'

/** GET /api/review — the teacher's manual-check queue (ECLASS-33/T7). */
export async function handleReviewQueue(req: NextRequest, payload: Payload) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  if (actor.role !== 'teacher') {
    return NextResponse.json({ ok: false, code: 'forbidden' }, { status: 403 })
  }
  const svc = createAttemptsService(payload)
  return NextResponse.json({ ok: true, items: await svc.reviewQueue(actor) })
}
