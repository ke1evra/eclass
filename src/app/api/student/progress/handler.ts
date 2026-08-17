import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'
import { createAttemptsService } from '@/attempts/service'

/** GET /api/student/progress — mastery by topic + checked history (ECLASS-37/S8). */
export async function handleStudentProgress(req: NextRequest, payload: Payload) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  if (actor.role !== 'student') {
    return NextResponse.json({ ok: false, code: 'forbidden' }, { status: 403 })
  }
  const svc = createAttemptsService(payload)
  return NextResponse.json({ ok: true, ...(await svc.progress(actor.id)) })
}
