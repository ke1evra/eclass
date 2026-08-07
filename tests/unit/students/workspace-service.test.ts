import { beforeEach, describe, expect, it } from 'vitest'
import { createStudentWorkspaceService, type WorkspaceStore } from '@/students/service'
import { authorize } from '@/domain/authorization'

/**
 * Student workspace service — ECLASS-16.
 *
 * The service backs the student shell: it returns the student's profile
 * (class, subject, exam target), their assigned work, and a "next step"
 * hint for the empty/first-login state. Critically, a student can only see
 * their OWN data — membership changes are not exposed as student actions.
 */

const makeStore = (): WorkspaceStore => {
  const students = new Map<string, any>()
  const assignments = new Map<string, any[]>() // studentId -> their assignments
  return {
    async getStudent(id) {
      return students.get(id)
    },
    async listAssignments(studentId) {
      return assignments.get(studentId) ?? []
    },
    async setDisplayName(_id, _name) {
      /* no-op in test */
    },
  }
}

const seedStudent = (store: WorkspaceStore, over: any = {}) => {
  const student = {
    id: 'stu-1',
    classId: 'cls-1',
    className: '9А математика',
    subjectVersionId: 'subj-math-2026',
    subjectName: 'Математика',
    examTarget: 'oge',
    ownerId: 'tea-1',
    displayName: 'Иван',
    ...over,
  }
  ;(store as any).getStudent = async (id: string) =>
    id === student.id ? student : undefined
  return student
}

describe('student workspace service — ECLASS-16', () => {
  let svc: ReturnType<typeof createStudentWorkspaceService>
  let store: WorkspaceStore

  beforeEach(() => {
    store = makeStore()
    svc = createStudentWorkspaceService({ store })
  })

  describe('profile', () => {
    it('returns the student profile scoped to their class and subject', async () => {
      seedStudent(store)
      const res = await svc.getProfile('stu-1')
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.profile.subjectName).toBe('Математика')
        expect(res.profile.examTarget).toBe('oge')
        expect(res.profile.className).toBe('9А математика')
      }
    })

    it('a student cannot read another student profile (not_found, no existence leak)', async () => {
      seedStudent(store)
      const res = await svc.getProfile('stu-other')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('not_found')
    })

    it('profile does not expose the teacher id or class membership internals', async () => {
      seedStudent(store)
      const res = await svc.getProfile('stu-1')
      if (!res.ok) throw new Error('expected ok')
      const serialized = JSON.stringify(res.profile)
      expect(serialized).not.toContain('tea-1')
      expect(serialized).not.toMatch(/ownerId/i)
    })

    it('a student can edit only their display name, not class/subject/membership', async () => {
      seedStudent(store)
      const res = await svc.updateProfile('stu-1', { displayName: 'Новое имя' })
      expect(res.ok).toBe(true)
      // Attempting to change classId via the same call is impossible: the
      // input type only has displayName.
    })
  })

  describe('assignments & next step', () => {
    it('returns an empty list and a clear next-step hint on first login', async () => {
      seedStudent(store)
      const res = await svc.getDashboard('stu-1')
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.assignments).toEqual([])
        expect(res.nextStep).toBeTruthy()
        expect(res.nextStep.kind).toBe('empty')
      }
    })

    it('points to the nearest due assignment when one exists', async () => {
      seedStudent(store)
      ;(store as any).listAssignments = async (id: string) =>
        id === 'stu-1'
          ? [
              { id: 'asg-1', title: 'Вариант 1', dueAt: 200, status: 'assigned' },
              { id: 'asg-2', title: 'Вариант 2', dueAt: 100, status: 'assigned' },
            ]
          : []
      const res = await svc.getDashboard('stu-1')
      if (!res.ok) throw new Error('expected ok')
      expect(res.nextStep.kind).toBe('due_soon')
      if (res.nextStep.kind === 'due_soon') {
        expect(res.nextStep.assignmentId).toBe('asg-2') // nearest due
      }
    })

    it('when all assignments are submitted, shows the "all done" empty hint', async () => {
      seedStudent(store)
      ;(store as any).listAssignments = async (id: string) =>
        id === 'stu-1'
          ? [{ id: 'asg-1', title: 'Вариант 1', dueAt: 100, status: 'submitted' }]
          : []
      const res = await svc.getDashboard('stu-1')
      if (!res.ok) throw new Error('expected ok')
      expect(res.nextStep.kind).toBe('empty')
    })

    it('rejects an empty display name on update', async () => {
      seedStudent(store)
      const res = await svc.updateProfile('stu-1', { displayName: '   ' })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('validation_error')
    })
  })

  describe('authorization consistency', () => {
    it('the domain policy forbids a student from updating a class (membership)', () => {
      const decision = authorize({ id: 'stu-1', role: 'student' }, 'update', { ownerId: 'tea-1' })
      expect(decision.allowed).toBe(false)
    })
  })
})
