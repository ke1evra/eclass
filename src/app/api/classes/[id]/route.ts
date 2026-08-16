import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleGetClass, handlePatchClass } from './handler'

/**
 * /api/classes/[id] — ECLASS-56/14. GET detail, PATCH rename/archive.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const payload = await getPayload({ config })
  const { id } = await params
  return handleGetClass(req, payload, id)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const payload = await getPayload({ config })
  const { id } = await params
  return handlePatchClass(req, payload, id)
}
