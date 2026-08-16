import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleCreateInvite } from './handler'

/** /api/classes/[id]/invites — mint a single-use invite (ECLASS-56/15). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const payload = await getPayload({ config })
  const { id } = await params
  return handleCreateInvite(req, payload, id)
}
