import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'
import { listBank, type QuestionType } from '@/assignments/service'

/**
 * GET /api/content?subjectVersionId=&type=&topic=&q= — teacher-facing bank
 * listing (ECLASS-20). Published revisions only; search is server-side
 * (no client regex injection). answerKey is NOT in the response shape —
 * the builder never needs it (grading is server-side at submit).
 */
export async function handleListContent(req: NextRequest, payload: Payload) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  if (actor.role !== 'teacher') {
    return NextResponse.json({ ok: false, code: 'forbidden' }, { status: 403 })
  }
  const sp = new URL(req.url).searchParams
  const subjectVersionId = sp.get('subjectVersionId')
  if (!subjectVersionId) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }
  const type = sp.get('type') as QuestionType | null
  const { items, total } = await listBank(payload, {
    subjectVersionId,
    type: type ?? undefined,
    topic: sp.get('topic') ?? undefined,
    q: sp.get('q') ?? undefined,
    page: Number(sp.get('page') ?? 1),
  })
  return NextResponse.json({
    ok: true,
    items: items.map((q) => ({
      code: q.code,
      type: q.type,
      topic: q.topic,
      stem: q.stem,
      options: q.options ?? [],
      points: q.points,
      source: q.source,
    })),
    total,
  })
}
