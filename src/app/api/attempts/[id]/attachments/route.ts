import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleUploadAttachment } from './handler'

/** POST /api/attempts/[id]/attachments — multipart upload (ECLASS-30). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const payload = await getPayload({ config })
  const { id } = await params
  return handleUploadAttachment(req, payload, id)
}
