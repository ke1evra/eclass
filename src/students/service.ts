/**
 * Student workspace service — ECLASS-16 (TDD-P1-04).
 *
 * Backs the student shell: profile (class/subject/exam target), the list of
 * assigned work, and a "next step" hint for the empty/first-login state.
 *
 * Security: a student reads only their own data. Membership changes (class,
 * subject) are NOT exposed as student actions — `updateProfile` accepts only
 * `displayName`. Teacher id and other internals are stripped from the profile
 * shape by construction.
 */

export interface StudentRecord {
  id: string
  classId: string
  className: string
  subjectVersionId: string
  subjectName: string
  examTarget: 'oge' | 'ege'
  ownerId: string
  displayName?: string
}

export interface StudentAssignment {
  id: string
  title: string
  dueAt?: number
  status: 'assigned' | 'in_progress' | 'submitted' | 'checked'
}

export interface WorkspaceStore {
  getStudent(id: string): Promise<StudentRecord | undefined>
  listAssignments(studentId: string): Promise<StudentAssignment[]>
  setDisplayName(id: string, name: string): Promise<void>
}

/** Profile shape exposed to the student — no teacher id, no membership internals. */
export interface StudentProfile {
  subjectName: string
  examTarget: 'oge' | 'ege'
  className: string
  displayName?: string
}

export type NextStep =
  | { kind: 'empty'; message: string }
  | { kind: 'due_soon'; assignmentId: string; message: string }

export type WorkspaceResult<T> = ({ ok: true } & T) | { ok: false; code: string }

interface Options {
  store: WorkspaceStore
}

const toProfile = (s: StudentRecord): StudentProfile => ({
  subjectName: s.subjectName,
  examTarget: s.examTarget,
  className: s.className,
  displayName: s.displayName,
})

const EMPTY_HINT = 'У вас пока нет назначенных работ. Когда учитель задаст работу, она появится здесь.'

export function createStudentWorkspaceService(opts: Options) {
  const { store } = opts

  const ownOrFail = async (studentId: string): Promise<WorkspaceResult<{ student: StudentRecord }>> => {
    const student = await store.getStudent(studentId)
    if (!student) return { ok: false, code: 'not_found' }
    return { ok: true, student }
  }

  return {
    async getProfile(studentId: string): Promise<WorkspaceResult<{ profile: StudentProfile }>> {
      const owned = await ownOrFail(studentId)
      if (!owned.ok) return owned
      return { ok: true, profile: toProfile(owned.student) }
    },

    /**
     * A student may edit ONLY their display name. Class/subject/membership
     * are not in the input shape, so they cannot be changed here.
     */
    async updateProfile(
      studentId: string,
      input: { displayName: string },
    ): Promise<WorkspaceResult<{ profile: StudentProfile }>> {
      const owned = await ownOrFail(studentId)
      if (!owned.ok) return owned
      if (!input.displayName.trim()) return { ok: false, code: 'validation_error' }
      await store.setDisplayName(studentId, input.displayName.trim().slice(0, 120))
      return { ok: true, profile: toProfile({ ...owned.student, displayName: input.displayName }) }
    },

    async getDashboard(
      studentId: string,
    ): Promise<WorkspaceResult<{ profile: StudentProfile; assignments: StudentAssignment[]; nextStep: NextStep }>> {
      const owned = await ownOrFail(studentId)
      if (!owned.ok) return owned
      const assignments = await store.listAssignments(studentId)

      let nextStep: NextStep
      if (assignments.length === 0) {
        nextStep = { kind: 'empty', message: EMPTY_HINT }
      } else {
        const pending = assignments
          .filter((a) => a.status === 'assigned' || a.status === 'in_progress')
          .sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER))
        const nearest = pending[0]
        nextStep = nearest
          ? { kind: 'due_soon', assignmentId: nearest.id, message: `Ближайшая работа: ${nearest.title}` }
          : { kind: 'empty', message: 'Все работы сданы. Новые появятся здесь.' }
      }

      return { ok: true, profile: toProfile(owned.student), assignments, nextStep }
    },
  }
}
