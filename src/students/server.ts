/**
 * Server-side wiring for the student workspace — ECLASS-16 / ECLASS-56.
 *
 * Payload/MongoDB-backed: the workspace is derived from memberships → classes
 * → users, scoped by the session Actor. No Map, no demo seeding — the
 * production /student path cannot surface fabricated data.
 */
import { getPayload } from 'payload'
import config from '@/payload.config'
import { createPayloadWorkspaceStore } from './payload-store'
import { createStudentWorkspaceService } from './service'

export async function getStudentWorkspaceService() {
  const payload = await getPayload({ config })
  return createStudentWorkspaceService({ store: createPayloadWorkspaceStore(payload) })
}
