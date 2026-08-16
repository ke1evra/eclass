import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleMe } from './handler'

/** GET /api/me — session probe (ECLASS-56). */
export async function GET(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleMe(req, payload)
}
