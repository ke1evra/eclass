import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleStudentProgress } from './handler'

/** GET /api/student/progress — mastery/progress (ECLASS-37). */
export async function GET(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleStudentProgress(req, payload)
}
