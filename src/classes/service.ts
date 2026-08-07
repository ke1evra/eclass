/**
 * Class & roster service — ECLASS-14 (TDD-P1-02).
 *
 * Wraps the class aggregate (a ClassEntity + its roster) behind a service
 * that enforces ownership via the domain authorization policy. Storage is
 * injected (`ClassStore`) so tests run in-memory and production swaps in
 * Payload. Soft-archiving preserves history: archived classes are hidden from
 * the default list but their assignments/submissions remain queryable.
 */
import { randomBytes } from 'node:crypto'
import { authorize, type Decision } from '@/domain/authorization'
import type { ClassEntity } from '@/domain/entities'

export interface StoredClass extends Omit<ClassEntity, 'inviteCode'> {
  archivedAt: number | null
}

export interface ClassStore {
  insertClass(c: StoredClass): Promise<void>
  getClass(id: string): Promise<StoredClass | undefined>
  listClasses(ownerId: string, opts: { includeArchived: boolean }): Promise<StoredClass[]>
  updateClass(id: string, patch: Partial<StoredClass>): Promise<void>
  addStudent(classId: string, studentId: string): Promise<void>
  removeStudent(classId: string, studentId: string): Promise<void>
  getRoster(classId: string): Promise<string[]>
  isMember(classId: string, studentId: string): Promise<boolean>
}

export type ClassResult<T> = ({ ok: true } & T) | { ok: false; code: string }

interface Options {
  store: ClassStore
}

const teacher = (id: string) => ({ id, role: 'teacher' as const })

const guard = (actorId: string, action: Parameters<typeof authorize>[1], resource: { ownerId?: string }): Decision =>
  authorize(teacher(actorId), action, resource)

export function createClassService(opts: Options) {
  const { store } = opts

  /** Ensure the class exists AND is owned by the actor; else not_found. */
  const ownOrFail = async (
    actorId: string,
    classId: string,
  ): Promise<ClassResult<{ cls: StoredClass }>> => {
    const cls = await store.getClass(classId)
    if (!cls) return { ok: false, code: 'not_found' }
    const d = guard(actorId, 'read', { ownerId: cls.ownerId })
    if (!d.allowed) return { ok: false, code: 'not_found' }
    return { ok: true, cls }
  }

  return {
    async createClass(input: {
      ownerId: string
      name: string
      subjectVersionId: string
    }): Promise<ClassResult<{ class: StoredClass }>> {
      if (!input.name.trim() || !input.subjectVersionId) {
        return { ok: false, code: 'validation_error' }
      }
      const cls: StoredClass = {
        id: `cls-${randomBytes(6).toString('hex')}`,
        ownerId: input.ownerId,
        subjectVersionId: input.subjectVersionId,
        name: input.name,
        archivedAt: null,
      }
      await store.insertClass(cls)
      return { ok: true, class: cls }
    },

    async renameClass(
      actorId: string,
      classId: string,
      name: string,
    ): Promise<ClassResult<{ class: StoredClass }>> {
      const owned = await ownOrFail(actorId, classId)
      if (!owned.ok) return owned
      if (!name.trim()) return { ok: false, code: 'validation_error' }
      const d = guard(actorId, 'update', { ownerId: owned.cls.ownerId })
      if (!d.allowed) return { ok: false, code: 'not_found' }
      await store.updateClass(classId, { name })
      return { ok: true, class: { ...owned.cls, name } }
    },

    async archiveClass(actorId: string, classId: string): Promise<ClassResult<{ class: StoredClass }>> {
      const owned = await ownOrFail(actorId, classId)
      if (!owned.ok) return owned
      const d = guard(actorId, 'delete', { ownerId: owned.cls.ownerId })
      if (!d.allowed) return { ok: false, code: 'not_found' }
      const archivedAt = Date.now()
      await store.updateClass(classId, { archivedAt })
      return { ok: true, class: { ...owned.cls, archivedAt } }
    },

    async listClasses(
      ownerId: string,
      opts: { includeArchived: boolean },
    ): Promise<StoredClass[]> {
      return store.listClasses(ownerId, opts)
    },

    async getClass(actorId: string, classId: string): Promise<ClassResult<{ class: StoredClass }>> {
      const owned = await ownOrFail(actorId, classId)
      if (!owned.ok) return owned
      return { ok: true, class: owned.cls }
    },

    async addStudent(
      actorId: string,
      classId: string,
      studentId: string,
    ): Promise<ClassResult<{ added: boolean }>> {
      const owned = await ownOrFail(actorId, classId)
      if (!owned.ok) return owned
      const d = guard(actorId, 'update', { ownerId: owned.cls.ownerId })
      if (!d.allowed) return { ok: false, code: 'not_found' }
      const already = await store.isMember(classId, studentId)
      if (already) return { ok: false, code: 'conflict' }
      await store.addStudent(classId, studentId)
      return { ok: true, added: true }
    },

    async removeStudent(
      actorId: string,
      classId: string,
      studentId: string,
    ): Promise<ClassResult<{ removed: boolean }>> {
      const owned = await ownOrFail(actorId, classId)
      if (!owned.ok) return owned
      const d = guard(actorId, 'update', { ownerId: owned.cls.ownerId })
      if (!d.allowed) return { ok: false, code: 'not_found' }
      await store.removeStudent(classId, studentId)
      return { ok: true, removed: true }
    },

    async moveStudent(
      actorId: string,
      studentId: string,
      fromClassId: string,
      toClassId: string,
    ): Promise<ClassResult<{ moved: boolean }>> {
      // Both classes must be owned by the same teacher (no cross-tenant move).
      const from = await ownOrFail(actorId, fromClassId)
      if (!from.ok) return from
      const to = await ownOrFail(actorId, toClassId)
      if (!to.ok) return to
      await store.removeStudent(fromClassId, studentId)
      // Avoid duplicate if already in target (idempotent move).
      if (!(await store.isMember(toClassId, studentId))) {
        await store.addStudent(toClassId, studentId)
      }
      return { ok: true, moved: true }
    },

    async getRoster(
      actorId: string,
      classId: string,
    ): Promise<ClassResult<{ studentIds: string[] }>> {
      const owned = await ownOrFail(actorId, classId)
      if (!owned.ok) return owned
      const studentIds = await store.getRoster(classId)
      return { ok: true, studentIds }
    },
  }
}
