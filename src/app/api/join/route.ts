import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleJoin } from './handler'

/** POST /api/join — atomic student invite acceptance (ECLASS-56/57). */
export async function POST(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleJoin(req, payload)
}
