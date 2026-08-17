import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveActorFromRequest } from '@/auth/route-actor'

/**
 * GET /api/attachments/[id] — authorized download (ECLASS-30).
 * Access: the attempt's student OR the assignment's teacher — nobody else;
 * the stored random name is never exposed (no guessable public URL).
 */
export async function handleDownloadAttachment(req: NextRequest, payload: Payload, id: string) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })

  const found = await payload.find({
    collection: 'attachments',
    where: { id: { equals: id } },
    limit: 1,
    overrideAccess: true,
  })
  const att = found.docs[0] as
    | { attemptId: string; studentId: string; storedName: string; originalName: string; mimeType: string }
    | undefined
  if (!att) return NextResponse.json({ ok: false, code: 'not_found' }, { status: 404 })

  const attemptRes = await payload.find({
    collection: 'attempts',
    where: { id: { equals: att.attemptId } },
    limit: 1,
    overrideAccess: true,
  })
  const attempt = attemptRes.docs[0] as { studentId: string; ownerId: string } | undefined
  const allowed =
    attempt &&
    (actor.role === 'student'
      ? attempt.studentId === actor.id
      : actor.role === 'teacher' && attempt.ownerId === actor.id)
  if (!allowed) return NextResponse.json({ ok: false, code: 'not_found' }, { status: 404 })

  const dir = process.env.UPLOADS_DIR ?? join(process.cwd(), 'uploads')
  const data = await readFile(join(dir, att.storedName)).catch(() => null)
  if (!data) return NextResponse.json({ ok: false, code: 'not_found' }, { status: 404 })

  return new NextResponse(new Uint8Array(data), {
    headers: {
      'content-type': att.mimeType,
      'content-disposition': `inline; filename="${encodeURIComponent(att.originalName)}"`,
      'cache-control': 'private, no-store',
    },
  })
}
