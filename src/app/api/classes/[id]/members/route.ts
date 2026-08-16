import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleGetMembers } from './handler'

/** /api/classes/[id]/members — roster for the class owner (ECLASS-56/14). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const payload = await getPayload({ config })
  const { id } = await params
  return handleGetMembers(req, payload, id)
}
