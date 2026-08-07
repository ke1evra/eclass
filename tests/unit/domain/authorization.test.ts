import { describe, expect, it } from 'vitest'
import { authorize, type Actor, type ClassEntity, type Assignment, type Submission } from '@/domain/authorization'
import type { Submission as LifecycleSubmission } from '@/domain/lifecycle'

const teacher = (id: string): Actor => ({ id, role: 'teacher' })
const student = (id: string): Actor => ({ id, role: 'student' })
const admin = (id: string): Actor => ({ id, role: 'admin' })

const ownClass = (): ClassEntity => ({
  id: 'cls-1',
  ownerId: 'tea-1',
  subjectVersionId: 'subj-math-2026',
  name: '9А математика',
})

const ownAssignment = (): Assignment => ({
  id: 'asg-1',
  classId: 'cls-1',
  ownerId: 'tea-1',
  title: 'Вариант 1',
  questionVersionIds: ['q-1', 'q-2'],
  recipientIds: ['stu-1'],
})

const ownSubmission = (over: Partial<LifecycleSubmission> = {}): Submission => ({
  id: 'sub-1',
  assignmentId: 'asg-1',
  studentId: 'stu-1',
  ownerId: 'tea-1',
  status: 'in_progress',
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
})

describe('authorization policy — ECLASS-9', () => {
  describe('teachers operate only on resources they own', () => {
    it('owner teacher can read their class', () => {
      expect(authorize(teacher('tea-1'), 'read', ownClass()).allowed).toBe(true)
    })

    it('owner teacher can update their assignment', () => {
      expect(authorize(teacher('tea-1'), 'update', ownAssignment()).allowed).toBe(true)
    })

    it('a different teacher reading a class gets NOT_FOUND (existence must not leak)', () => {
      const d = authorize(teacher('tea-other'), 'read', ownClass())
      expect(d.allowed).toBe(false)
      if (!d.allowed) {
        expect(d.code).toBe('not_found')
      }
    })

    it('a different teacher mutating a class gets NOT_FOUND too', () => {
      const d = authorize(teacher('tea-other'), 'update', ownClass())
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.code).toBe('not_found')
    })

    it('owner teacher can read a submission to their assignment', () => {
      expect(authorize(teacher('tea-1'), 'read', ownSubmission()).allowed).toBe(true)
    })

    it('foreign submission is not_found for another teacher', () => {
      const d = authorize(teacher('tea-other'), 'read', ownSubmission())
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.code).toBe('not_found')
    })
  })

  describe('students see only their own data', () => {
    it('student can read their own submission', () => {
      expect(authorize(student('stu-1'), 'read', ownSubmission()).allowed).toBe(true)
    })

    it('student cannot read another student submission — not_found', () => {
      const d = authorize(student('stu-other'), 'read', ownSubmission())
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.code).toBe('not_found')
    })

    it('student cannot create an assignment — forbidden (role mismatch)', () => {
      const d = authorize(student('stu-1'), 'create', ownAssignment())
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.code).toBe('forbidden')
    })

    it('student cannot update a class — forbidden', () => {
      const d = authorize(student('stu-1'), 'update', ownClass())
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.code).toBe('forbidden')
    })

    it('student cannot submit on behalf of another student — not_found', () => {
      const foreign = ownSubmission({ studentId: 'stu-other' })
      const d = authorize(student('stu-1'), 'submit', foreign)
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.code).toBe('not_found')
    })
  })

  describe('admins are trusted but tenant-scoped', () => {
    it('admin can read any class for support purposes', () => {
      expect(authorize(admin('adm-1'), 'read', ownClass()).allowed).toBe(true)
    })

    it('admin mutating production data is forbidden by default (audit-required path)', () => {
      const d = authorize(admin('adm-1'), 'update', ownClass())
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.code).toBe('forbidden')
    })
  })
})
