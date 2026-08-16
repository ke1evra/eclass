import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleResetConfirm } from './handler'

/** POST /api/auth/password-reset/confirm — consume token, set password (ECLASS-69). */
export async function POST(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleResetConfirm(req, payload)
}
