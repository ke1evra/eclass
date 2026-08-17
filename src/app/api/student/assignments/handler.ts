import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'
import { createAttemptsService } from '@/attempts/service'

/**
 * GET /api/student/assignments — the student's own works with statuses
 * (ECLASS-27/S2). Identity strictly from the session cookie.
 */
export async function handleStudentAssignments(req: NextRequest, payload: Payload) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  if (actor.role !== 'student') {
    return NextResponse.json({ ok: false, code: 'forbidden' }, { status: 403 })
  }
  const svc = createAttemptsService(payload)
  return NextResponse.json({ ok: true, items: await svc.listForStudent(actor.id) })
}
