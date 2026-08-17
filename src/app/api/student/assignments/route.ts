import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleStudentAssignments } from './handler'

/** GET /api/student/assignments — student works list (S2). */
export async function GET(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleStudentAssignments(req, payload)
}
