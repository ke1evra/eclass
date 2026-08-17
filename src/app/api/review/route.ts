import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleReviewQueue } from './handler'

/** GET /api/review — review queue (ECLASS-33). */
export async function GET(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleReviewQueue(req, payload)
}
