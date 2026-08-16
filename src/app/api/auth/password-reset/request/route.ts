import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleResetRequest } from './handler'

/** POST /api/auth/password-reset/request — A5 (ECLASS-69). */
export async function POST(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleResetRequest(req, payload)
}
