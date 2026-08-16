/**
 * Class & roster service — ECLASS-14, fixed in CB-3 (ECLASS-50).
 *
 * Wraps the class aggregate (a ClassEntity + its roster) behind a service
 * that enforces authorization via the domain policy. Storage is injected
 * (`ClassStore`) so tests run in-memory and production swaps in Payload.
 *
 * SECURITY (CB-3): every method takes an `Actor` ({ id, role }) — never a bare
 * ownerId. `createClass` refuses a non-teacher actor with `forbidden` on the
 * real path. This closes the role-escalation hole where a student could create
 * a class by passing their id as ownerId.
 */
import { authorize, type Actor, type Decision } from '@/domain/authorization'
import type { ClassEntity } from '@/domain/entities'
import { findSubjectVersion } from '@/content/catalog'

export interface StoredClass extends Omit<ClassEntity, 'inviteCode'> {
  archivedAt: number | null
}

export interface ClassStore {
  /**
   * Insert a class and return the CANONICAL stored record. The store assigns
   * the real id (Mongo ObjectId in production) — callers must use the returned
   * value, never a locally-generated placeholder id.
   */
  insertClass(c: Omit<StoredClass, 'id'>): Promise<StoredClass>
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

const guard = (actor: Actor, action: Parameters<typeof authorize>[1], resource: { ownerId?: string }): Decision =>
  authorize(actor, action, resource)

export function createClassService(opts: Options) {
  const { store } = opts

  /** Ensure the class exists AND is owned by the actor; else not_found. */
  const ownOrFail = async (
    actor: Actor,
    classId: string,
  ): Promise<ClassResult<{ cls: StoredClass }>> => {
    const cls = await store.getClass(classId)
    if (!cls) return { ok: false, code: 'not_found' }
    const d = guard(actor, 'read', { ownerId: cls.ownerId })
    if (!d.allowed) return { ok: false, code: 'not_found' }
    return { ok: true, cls }
  }

  return {
    async createClass(input: {
      actor: Actor
      name: string
      subjectVersionId: string
    }): Promise<ClassResult<{ class: StoredClass }>> {
      // Role gate FIRST: only a teacher may create a class. This runs before
      // any ownership reasoning so a student actor is refused outright.
      const createDecision = guard(input.actor, 'create', { ownerId: input.actor.id })
      if (!createDecision.allowed) return { ok: false, code: 'forbidden' }

      // The subject version must exist in the catalog: a class identity is
      // reproducible (T2 selects from the list) and the student workspace
      // derives subjectName/exam from it — free-text ids are refused here, at
      // the SERVICE layer, so the API route and the UI action are covered by
      // the same rule (ECLASS-14/56 review finding).
      if (!input.name.trim() || !findSubjectVersion(input.subjectVersionId)) {
        return { ok: false, code: 'validation_error' }
      }
      const cls = await store.insertClass({
        ownerId: input.actor.id,
        subjectVersionId: input.subjectVersionId,
        name: input.name.trim(),
        archivedAt: null,
      })
      return { ok: true, class: cls }
    },

    async renameClass(
      actor: Actor,
      classId: string,
      name: string,
    ): Promise<ClassResult<{ class: StoredClass }>> {
      // Role gate first: a student attempting a teacher-only mutation is
      // 'forbidden' regardless of ownership — this is a role mismatch, not a
      // cross-tenant probe, so we don't hide existence from them.
      if (actor.role !== 'teacher') return { ok: false, code: 'forbidden' }
      const owned = await ownOrFail(actor, classId)
      if (!owned.ok) return owned
      if (!name.trim()) return { ok: false, code: 'validation_error' }
      await store.updateClass(classId, { name })
      return { ok: true, class: { ...owned.cls, name } }
    },

    async archiveClass(actor: Actor, classId: string): Promise<ClassResult<{ class: StoredClass }>> {
      if (actor.role !== 'teacher') return { ok: false, code: 'forbidden' }
      const owned = await ownOrFail(actor, classId)
      if (!owned.ok) return owned
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

    async getClass(actor: Actor, classId: string): Promise<ClassResult<{ class: StoredClass }>> {
      const owned = await ownOrFail(actor, classId)
      if (!owned.ok) return owned
      return { ok: true, class: owned.cls }
    },

    async addStudent(
      actor: Actor,
      classId: string,
      studentId: string,
    ): Promise<ClassResult<{ added: boolean }>> {
      if (actor.role !== 'teacher') return { ok: false, code: 'forbidden' }
      const owned = await ownOrFail(actor, classId)
      if (!owned.ok) return owned
      const already = await store.isMember(classId, studentId)
      if (already) return { ok: false, code: 'conflict' }
      await store.addStudent(classId, studentId)
      return { ok: true, added: true }
    },

    async removeStudent(
      actor: Actor,
      classId: string,
      studentId: string,
    ): Promise<ClassResult<{ removed: boolean }>> {
      if (actor.role !== 'teacher') return { ok: false, code: 'forbidden' }
      const owned = await ownOrFail(actor, classId)
      if (!owned.ok) return owned
      await store.removeStudent(classId, studentId)
      return { ok: true, removed: true }
    },

    async moveStudent(
      actor: Actor,
      studentId: string,
      fromClassId: string,
      toClassId: string,
    ): Promise<ClassResult<{ moved: boolean }>> {
      if (actor.role !== 'teacher') return { ok: false, code: 'forbidden' }
      const from = await ownOrFail(actor, fromClassId)
      if (!from.ok) return from
      const to = await ownOrFail(actor, toClassId)
      if (!to.ok) return to
      await store.removeStudent(fromClassId, studentId)
      if (!(await store.isMember(toClassId, studentId))) {
        await store.addStudent(toClassId, studentId)
      }
      return { ok: true, moved: true }
    },

    async getRoster(
      actor: Actor,
      classId: string,
    ): Promise<ClassResult<{ studentIds: string[] }>> {
      if (actor.role !== 'teacher') return { ok: false, code: 'forbidden' }
      const owned = await ownOrFail(actor, classId)
      if (!owned.ok) return owned
      const studentIds = await store.getRoster(classId)
      return { ok: true, studentIds }
    },
  }
}
