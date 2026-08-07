/**
 * Server-side wiring for the student workspace service — ECLASS-16.
 *
 * Returns a service backed by an in-memory store seeded for the P1 skeleton.
 * The real Payload-backed store lands with ECLASS-17 (tenant isolation +
 * auth-контур). Keeping the seam here means the page can render today while
 * the storage layer is swapped without touching the page or the service.
 */
import { createStudentWorkspaceService, type WorkspaceStore } from './service'

let cached: ReturnType<typeof createStudentWorkspaceService> | null = null

const seedStore = (): WorkspaceStore => {
  const students = new Map<string, any>([
    [
      'stu-demo',
      {
        id: 'stu-demo',
        classId: 'cls-demo',
        className: '9А математика',
        subjectVersionId: 'subj-math-2026',
        subjectName: 'Математика',
        examTarget: 'oge' as const,
        ownerId: 'tea-demo',
      },
    ],
  ])
  const assignments = new Map<string, any[]>([['stu-demo', []]])
  return {
    async getStudent(id) {
      return students.get(id)
    },
    async listAssignments(studentId) {
      return assignments.get(studentId) ?? []
    },
    async setDisplayName(id, name) {
      const s = students.get(id)
      if (s) s.displayName = name
    },
  }
}

export function getStudentWorkspaceService() {
  if (!cached) cached = createStudentWorkspaceService({ store: seedStore() })
  return cached
}
