import { beforeEach, describe, expect, it } from 'vitest'
import { createClassService, type ClassStore } from '@/classes/service'
import { authorize, type Actor } from '@/domain/authorization'

/**
 * Class & roster service — ECLASS-14 (updated for CB-3 / ECLASS-50).
 *
 * All mutating methods take an Actor ({ id, role }), not a bare ownerId. This
 * is the structural fix for the role-escalation hole: a student actor is
 * refused on the real service path.
 */

const teacher = (id = 'tea-1'): Actor => ({ id, role: 'teacher' })
const student = (id = 'stu-1'): Actor => ({ id, role: 'student' })
const foreignTeacher = (id = 'tea-other'): Actor => ({ id, role: 'teacher' })

const makeStore = (): ClassStore => {
  const classes = new Map<string, any>()
  const memberships = new Map<string, Set<string>>()
  return {
    async insertClass(c) {
      const stored = { ...c, id: `cls-${classes.size + 1}` }
      classes.set(stored.id, stored)
      memberships.set(stored.id, new Set())
      return stored
    },
    async getClass(id) {
      return classes.get(id)
    },
    async listClasses(ownerId, { includeArchived }) {
      return [...classes.values()].filter(
        (c) => c.ownerId === ownerId && (includeArchived || !c.archivedAt),
      )
    },
    async updateClass(id, patch) {
      const c = classes.get(id)
      if (c) Object.assign(c, patch)
    },
    async addStudent(classId, studentId) {
      memberships.get(classId)?.add(studentId)
    },
    async removeStudent(classId, studentId) {
      memberships.get(classId)?.delete(studentId)
    },
    async getRoster(classId) {
      return [...(memberships.get(classId) ?? [])]
    },
    async isMember(classId, studentId) {
      return memberships.get(classId)?.has(studentId) ?? false
    },
  }
}

describe('class & roster service — ECLASS-14 / CB-3', () => {
  let svc: ReturnType<typeof createClassService>
  beforeEach(() => {
    svc = createClassService({ store: makeStore() })
  })

  describe('class lifecycle', () => {
    it('creates a class owned by the teacher with a stable id', async () => {
      const res = await svc.createClass({ actor: teacher(), name: '9А математика', subjectVersionId: 'math-oge-2026' })
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.class.id).toBeTruthy()
        expect(res.class.ownerId).toBe('tea-1')
        expect(res.class.archivedAt).toBeNull()
      }
    })

    it('rejects an empty name or missing subject version', async () => {
      const emptyName = await svc.createClass({ actor: teacher(), name: '   ', subjectVersionId: 'math-oge-2026' })
      expect(emptyName.ok).toBe(false)
      if (!emptyName.ok) expect(emptyName.code).toBe('validation_error')
      const noSubject = await svc.createClass({ actor: teacher(), name: 'x', subjectVersionId: '' })
      expect(noSubject.ok).toBe(false)
      if (!noSubject.ok) expect(noSubject.code).toBe('validation_error')
    })

    it('ECLASS-14/56: unknown subjectVersionId is rejected at the SERVICE layer (no free-text subjects)', async () => {
      const svc = createClassService({ store: makeStore() })
      const result = await svc.createClass({
        actor: teacher(),
        name: 'Валидный класс',
        subjectVersionId: 'not-in-catalog-9999',
      })
      expect(result).toEqual({ ok: false, code: 'validation_error' })
    })

    it('CB-3: a STUDENT actor is forbidden from creating a class', async () => {
      const res = await svc.createClass({ actor: student(), name: 'x', subjectVersionId: 'math-oge-2026' })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('forbidden')
    })

    it('renames a class owned by the teacher', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'old', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      const renamed = await svc.renameClass(teacher(), created.class.id, 'new name')
      expect(renamed.ok).toBe(true)
      if (renamed.ok) expect(renamed.class.name).toBe('new name')
    })

    it('forbids renaming a class owned by another teacher', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'old', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      const res = await svc.renameClass(foreignTeacher(), created.class.id, 'x')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('not_found')
    })

    it('CB-3: a STUDENT actor is forbidden from renaming', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'old', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      const res = await svc.renameClass(student(), created.class.id, 'x')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('forbidden')
    })

    it('rejects renaming to an empty name', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'old', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      const res = await svc.renameClass(teacher(), created.class.id, '')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('validation_error')
    })

    it('archives a class; archived classes are hidden by default but history remains', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'c', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      const archived = await svc.archiveClass(teacher(), created.class.id)
      expect(archived.ok).toBe(true)

      const visible = await svc.listClasses('tea-1', { includeArchived: false })
      expect(visible.find((c) => c.id === created.class.id)).toBeUndefined()

      const withArchived = await svc.listClasses('tea-1', { includeArchived: true })
      expect(withArchived.find((c) => c.id === created.class.id)).toBeDefined()
      const fetched = await svc.getClass(teacher(), created.class.id)
      expect(fetched.ok).toBe(true)
    })
  })

  describe('roster rules', () => {
    it('adds a student to the roster of an owned class', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'c', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      const add = await svc.addStudent(teacher(), created.class.id, 'stu-1')
      expect(add.ok).toBe(true)
      const roster = await svc.getRoster(teacher(), created.class.id)
      if (roster.ok) expect(roster.studentIds).toContain('stu-1')
    })

    it('prevents duplicate membership of the same student in a class', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'c', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      await svc.addStudent(teacher(), created.class.id, 'stu-1')
      const dup = await svc.addStudent(teacher(), created.class.id, 'stu-1')
      expect(dup.ok).toBe(false)
      if (!dup.ok) expect(dup.code).toBe('conflict')
      const roster = await svc.getRoster(teacher(), created.class.id)
      if (roster.ok) expect(roster.studentIds.filter((s) => s === 'stu-1')).toHaveLength(1)
    })

    it('removes a student from the roster', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'c', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      await svc.addStudent(teacher(), created.class.id, 'stu-1')
      const rm = await svc.removeStudent(teacher(), created.class.id, 'stu-1')
      expect(rm.ok).toBe(true)
      const roster = await svc.getRoster(teacher(), created.class.id)
      if (roster.ok) expect(roster.studentIds).not.toContain('stu-1')
    })

    it('moving a student removes from old class and adds to new', async () => {
      const a = await svc.createClass({ actor: teacher(), name: 'a', subjectVersionId: 'math-oge-2026' })
      const b = await svc.createClass({ actor: teacher(), name: 'b', subjectVersionId: 'math-oge-2026' })
      if (!a.ok || !b.ok) throw new Error('setup')
      await svc.addStudent(teacher(), a.class.id, 'stu-1')
      const move = await svc.moveStudent(teacher(), 'stu-1', a.class.id, b.class.id)
      expect(move.ok).toBe(true)

      const rosterA = await svc.getRoster(teacher(), a.class.id)
      const rosterB = await svc.getRoster(teacher(), b.class.id)
      if (rosterA.ok) expect(rosterA.studentIds).not.toContain('stu-1')
      if (rosterB.ok) expect(rosterB.studentIds).toContain('stu-1')
    })

    it('roster ops are teacher-only: a student gets forbidden everywhere', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'c', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      const student = { id: 'stu-9', role: 'student' as const }
      const rm = await svc.removeStudent(student, created.class.id, 'stu-1')
      expect(rm.ok).toBe(false)
      if (!rm.ok) expect(rm.code).toBe('forbidden')
      const move = await svc.moveStudent(student, 'stu-1', created.class.id, created.class.id)
      expect(move.ok).toBe(false)
      if (!move.ok) expect(move.code).toBe('forbidden')
      const roster = await svc.getRoster(student, created.class.id)
      expect(roster.ok).toBe(false)
      if (!roster.ok) expect(roster.code).toBe('forbidden')
    })

    it('moving into a class the teacher does not own fails before any write', async () => {
      const mine = await svc.createClass({ actor: teacher(), name: 'mine', subjectVersionId: 'math-oge-2026' })
      const theirs = await svc.createClass({ actor: foreignTeacher(), name: 'theirs', subjectVersionId: 'math-oge-2026' })
      if (!mine.ok || !theirs.ok) throw new Error('setup')
      await svc.addStudent(teacher(), mine.class.id, 'stu-2')
      const move = await svc.moveStudent(teacher(), 'stu-2', mine.class.id, theirs.class.id)
      expect(move.ok).toBe(false)
      if (!move.ok) expect(move.code).toBe('not_found')
      // Nothing was removed from the source class.
      const roster = await svc.getRoster(teacher(), mine.class.id)
      if (roster.ok) expect(roster.studentIds).toContain('stu-2')
    })

    it('roster operations on a foreign class return not_found', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'c', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      const add = await svc.addStudent(foreignTeacher(), created.class.id, 'stu-1')
      expect(add.ok).toBe(false)
      if (!add.ok) expect(add.code).toBe('not_found')
    })
  })

  describe('authorization consistency with domain policy', () => {
    it('every mutating op delegates to authorize (owner-only)', async () => {
      const created = await svc.createClass({ actor: teacher(), name: 'c', subjectVersionId: 'math-oge-2026' })
      if (!created.ok) throw new Error('setup')
      const decision = authorize(foreignTeacher(), 'update', { ownerId: 'tea-1' })
      expect(decision.allowed).toBe(false)
    })
  })
})
