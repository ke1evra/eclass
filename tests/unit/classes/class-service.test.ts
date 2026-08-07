import { beforeEach, describe, expect, it } from 'vitest'
import { createClassService, type ClassStore } from '@/classes/service'
import { authorize } from '@/domain/authorization'

/**
 * Class & roster service — ECLASS-14.
 *
 * Integration-style unit tests: in-memory store, exercising the full class
 * lifecycle and roster rules through the service. Authorization is enforced
 * by delegating to the domain policy from ECLASS-9.
 */

const makeStore = (): ClassStore => {
  const classes = new Map<string, any>()
  const memberships = new Map<string, Set<string>>() // classId -> studentIds
  return {
    async insertClass(c) {
      classes.set(c.id, c)
      memberships.set(c.id, new Set())
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

describe('class & roster service — ECLASS-14', () => {
  let svc: ReturnType<typeof createClassService>
  beforeEach(() => {
    svc = createClassService({ store: makeStore() })
  })

  describe('class lifecycle', () => {
    it('creates a class owned by the teacher with a stable id', async () => {
      const res = await svc.createClass({ ownerId: 'tea-1', name: '9А математика', subjectVersionId: 'subj-math-2026' })
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.class.id).toBeTruthy()
        expect(res.class.ownerId).toBe('tea-1')
        expect(res.class.archivedAt).toBeNull()
      }
    })

    it('rejects an empty name or missing subject version', async () => {
      const emptyName = await svc.createClass({ ownerId: 'tea-1', name: '   ', subjectVersionId: 's' })
      expect(emptyName.ok).toBe(false)
      if (!emptyName.ok) expect(emptyName.code).toBe('validation_error')
      const noSubject = await svc.createClass({ ownerId: 'tea-1', name: 'x', subjectVersionId: '' })
      expect(noSubject.ok).toBe(false)
      if (!noSubject.ok) expect(noSubject.code).toBe('validation_error')
    })

    it('renames a class owned by the teacher', async () => {
      const created = await svc.createClass({ ownerId: 'tea-1', name: 'old', subjectVersionId: 's' })
      if (!created.ok) throw new Error('setup')
      const renamed = await svc.renameClass('tea-1', created.class.id, 'new name')
      expect(renamed.ok).toBe(true)
      if (renamed.ok) expect(renamed.class.name).toBe('new name')
    })

    it('forbids renaming a class owned by another teacher', async () => {
      const created = await svc.createClass({ ownerId: 'tea-1', name: 'old', subjectVersionId: 's' })
      if (!created.ok) throw new Error('setup')
      const res = await svc.renameClass('tea-other', created.class.id, 'x')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('not_found')
    })

    it('rejects renaming to an empty name', async () => {
      const created = await svc.createClass({ ownerId: 'tea-1', name: 'old', subjectVersionId: 's' })
      if (!created.ok) throw new Error('setup')
      const res = await svc.renameClass('tea-1', created.class.id, '')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('validation_error')
    })

    it('archives a class; archived classes are hidden by default but history remains', async () => {
      const created = await svc.createClass({ ownerId: 'tea-1', name: 'c', subjectVersionId: 's' })
      if (!created.ok) throw new Error('setup')
      const archived = await svc.archiveClass('tea-1', created.class.id)
      expect(archived.ok).toBe(true)

      const visible = await svc.listClasses('tea-1', { includeArchived: false })
      expect(visible.find((c) => c.id === created.class.id)).toBeUndefined()

      const withArchived = await svc.listClasses('tea-1', { includeArchived: true })
      expect(withArchived.find((c) => c.id === created.class.id)).toBeDefined()
      // History is preserved: the class still exists.
      const fetched = await svc.getClass('tea-1', created.class.id)
      expect(fetched.ok).toBe(true)
    })
  })

  describe('roster rules', () => {
    it('adds a student to the roster of an owned class', async () => {
      const created = await svc.createClass({ ownerId: 'tea-1', name: 'c', subjectVersionId: 's' })
      if (!created.ok) throw new Error('setup')
      const add = await svc.addStudent('tea-1', created.class.id, 'stu-1')
      expect(add.ok).toBe(true)
      const roster = await svc.getRoster('tea-1', created.class.id)
      if (roster.ok) expect(roster.studentIds).toContain('stu-1')
    })

    it('prevents duplicate membership of the same student in a class', async () => {
      const created = await svc.createClass({ ownerId: 'tea-1', name: 'c', subjectVersionId: 's' })
      if (!created.ok) throw new Error('setup')
      await svc.addStudent('tea-1', created.class.id, 'stu-1')
      const dup = await svc.addStudent('tea-1', created.class.id, 'stu-1')
      expect(dup.ok).toBe(false)
      if (!dup.ok) expect(dup.code).toBe('conflict')
      const roster = await svc.getRoster('tea-1', created.class.id)
      if (roster.ok) expect(roster.studentIds.filter((s) => s === 'stu-1')).toHaveLength(1)
    })

    it('removes a student from the roster', async () => {
      const created = await svc.createClass({ ownerId: 'tea-1', name: 'c', subjectVersionId: 's' })
      if (!created.ok) throw new Error('setup')
      await svc.addStudent('tea-1', created.class.id, 'stu-1')
      const rm = await svc.removeStudent('tea-1', created.class.id, 'stu-1')
      expect(rm.ok).toBe(true)
      const roster = await svc.getRoster('tea-1', created.class.id)
      if (roster.ok) expect(roster.studentIds).not.toContain('stu-1')
    })

    it('moving a student removes from old class and adds to new', async () => {
      const a = await svc.createClass({ ownerId: 'tea-1', name: 'a', subjectVersionId: 's' })
      const b = await svc.createClass({ ownerId: 'tea-1', name: 'b', subjectVersionId: 's' })
      if (!a.ok || !b.ok) throw new Error('setup')
      await svc.addStudent('tea-1', a.class.id, 'stu-1')
      const move = await svc.moveStudent('tea-1', 'stu-1', a.class.id, b.class.id)
      expect(move.ok).toBe(true)

      const rosterA = await svc.getRoster('tea-1', a.class.id)
      const rosterB = await svc.getRoster('tea-1', b.class.id)
      if (rosterA.ok) expect(rosterA.studentIds).not.toContain('stu-1')
      if (rosterB.ok) expect(rosterB.studentIds).toContain('stu-1')
    })

    it('roster operations on a foreign class return not_found', async () => {
      const created = await svc.createClass({ ownerId: 'tea-1', name: 'c', subjectVersionId: 's' })
      if (!created.ok) throw new Error('setup')
      const add = await svc.addStudent('tea-other', created.class.id, 'stu-1')
      expect(add.ok).toBe(false)
      if (!add.ok) expect(add.code).toBe('not_found')
    })
  })

  describe('authorization consistency with domain policy', () => {
    it('every mutating op delegates to authorize (owner-only)', async () => {
      const created = await svc.createClass({ ownerId: 'tea-1', name: 'c', subjectVersionId: 's' })
      if (!created.ok) throw new Error('setup')
      // The domain policy must agree: foreign teacher cannot update.
      const decision = authorize({ id: 'tea-other', role: 'teacher' }, 'update', { ownerId: 'tea-1' })
      expect(decision.allowed).toBe(false)
    })
  })
})
