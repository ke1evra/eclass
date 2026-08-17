import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleDownloadAttachment } from './handler'

/** GET /api/attachments/[id] — authorized download (ECLASS-30). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const payload = await getPayload({ config })
  const { id } = await params
  return handleDownloadAttachment(req, payload, id)
}
