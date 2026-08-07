/**
 * Server-side wiring for the student workspace service — ECLASS-16.
 *
 * Returns a service backed by an in-memory store. The student identity MUST
 * come from an authenticated session (CB-4 / ECLASS-51), never from a query
 * parameter; this file intentionally exposes NO demo seeding on the
 * production path. Seeding is allowed only under ALLOW_TEST_SEEDING (CI/dev).
 *
 * The real Payload-backed store lands with ECLASS-17/51.
 */
import { createStudentWorkspaceService, type StudentRecord, type WorkspaceStore } from './service'

let cached: ReturnType<typeof createStudentWorkspaceService> | null = null

const buildStore = (): WorkspaceStore => {
  const students = new Map<string, StudentRecord>()
  return {
    async getStudent(id) {
      return students.get(id)
    },
    async listAssignments(_studentId) {
      // Returns StudentAssignment[]; empty until assignments land (ECLASS-23+).
      return []
    },
    async setDisplayName(id, name) {
      const s = students.get(id)
      if (s) s.displayName = name
    },
  }
}

/**
 * Development/CI-only seed. Gated by ALLOW_TEST_SEEDING and never active in a
 * production build — `NODE_ENV=production` short-circuits to an empty store.
 */
const maybeSeed = (store: WorkspaceStore): void => {
  if (process.env.NODE_ENV === 'production') return
  if (process.env.ALLOW_TEST_SEEDING !== 'true') return
  // Seeding helper reserved for E2E fixtures; no demo student by default so the
  // production /student path cannot surface fake data.
  void store
}

export function getStudentWorkspaceService() {
  if (!cached) {
    const store = buildStore()
    maybeSeed(store)
    cached = createStudentWorkspaceService({ store })
  }
  return cached
}
