import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveActorFromRequest } from '@/auth/route-actor'

/**
 * POST /api/attempts/[id]/attachments — multipart upload for extended answers
 * (ECLASS-30). Student-owned attempt only; submitted work is frozen. MIME
 * allowlist (jpeg/png/pdf) + 10MB cap enforced here; files are stored under
 * random names in UPLOADS_DIR — the original filename is metadata, never a
 * path; no public URLs (download goes through /api/attachments/[id] with the
 * same access checks). EXIF-stripping/malware scan is out of MVP scope.
 */
const ALLOWED: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/pdf': '.pdf',
}
const MAX_BYTES = 10 * 1024 * 1024

export async function handleUploadAttachment(req: NextRequest, payload: Payload, attemptId: string) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  if (actor.role !== 'student') {
    return NextResponse.json({ ok: false, code: 'forbidden' }, { status: 403 })
  }

  const found = await payload.find({
    collection: 'attempts',
    where: { id: { equals: attemptId } },
    limit: 1,
    overrideAccess: true,
  })
  const at = found.docs[0] as { studentId: string; status: string } | undefined
  if (!at || at.studentId !== actor.id) {
    return NextResponse.json({ ok: false, code: 'not_found' }, { status: 404 })
  }
  if (at.status === 'submitted' || at.status === 'checked') {
    return NextResponse.json({ ok: false, code: 'already_submitted' }, { status: 409 })
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  const questionCode = String(form?.get('code') ?? '')
  if (!(file instanceof File) || !questionCode) {
    return NextResponse.json({ ok: false, code: 'validation_error' }, { status: 422 })
  }
  const ext = ALLOWED[file.type]
  if (!ext) {
    return NextResponse.json({ ok: false, code: 'unsupported_media_type' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, code: 'payload_too_large' }, { status: 413 })
  }

  const dir = process.env.UPLOADS_DIR ?? join(process.cwd(), 'uploads')
  await mkdir(dir, { recursive: true })
  const storedName = `${randomBytes(16).toString('hex')}${ext}`
  await writeFile(join(dir, storedName), Buffer.from(await file.arrayBuffer()))

  const record = await payload.create({
    collection: 'attachments',
    data: {
      attemptId,
      questionCode,
      studentId: actor.id,
      storedName,
      originalName: file.name.slice(0, 120),
      mimeType: file.type,
      size: file.size,
      createdAt: Date.now(),
    },
    overrideAccess: true,
  })
  return NextResponse.json({ ok: true, attachmentId: String(record.id) }, { status: 201 })
}
