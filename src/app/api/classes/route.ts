import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleCreateClass, handleListClasses } from './handler'

/**
 * /api/classes — ECLASS-56. POST creates, GET lists (see handler.ts for the
 * contract and security notes; route.ts exports only HTTP symbols).
 */
export async function POST(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleCreateClass(req, payload)
}

export async function GET(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleListClasses(req, payload)
}
