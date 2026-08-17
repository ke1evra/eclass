import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleListContent } from './handler'

/** GET /api/content — question bank listing for the builder (ECLASS-20). */
export async function GET(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleListContent(req, payload)
}
