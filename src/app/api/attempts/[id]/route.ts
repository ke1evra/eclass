import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleAttemptAction, handleGetAttempt } from './handler'

/** /api/attempts/[id] — view (GET) and actions (POST ?action=…). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const payload = await getPayload({ config })
  const { id } = await params
  return handleGetAttempt(req, payload, id)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const payload = await getPayload({ config })
  const { id } = await params
  return handleAttemptAction(req, payload, id)
}
