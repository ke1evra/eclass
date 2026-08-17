import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleCreateAssignment, handleListAssignments } from './handler'

/** /api/assignments — create+assign (POST) and class list (GET). */
export async function POST(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleCreateAssignment(req, payload)
}

export async function GET(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleListAssignments(req, payload)
}
