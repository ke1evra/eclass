/**
 * Payload-backed WorkspaceStore — ECLASS-56 (Stage B).
 *
 * Replaces the Map-backed store on the production path. The student's
 * workspace is DERIVED from persisted rows: membership → class → user. There
 * is no separate "student record" to drift out of sync, and every query is
 * scoped by the studentId taken from the session Actor (never from a client
 * parameter).
 *
 * listAssignments stays empty until the assignment slice lands (ECLASS-23+) —
 * an honest empty state (E3) rather than fabricated data.
 */
import type { Payload } from 'payload'
import type { StudentAssignment, StudentRecord, WorkspaceStore } from './service'
import { findSubjectVersion } from '@/content/catalog'

export function createPayloadWorkspaceStore(payload: Payload): WorkspaceStore {
  return {
    async getStudent(id) {
      const memberships = await payload.find({
        collection: 'memberships',
        where: { studentId: { equals: id } },
        limit: 1,
        overrideAccess: true,
        depth: 0,
      })
      const membership = memberships.docs[0] as { classId: string } | undefined
      if (!membership) return undefined

      let cls: { ownerId: string; subjectVersionId: string; name: string }
      try {
        cls = (await payload.findByID({
          collection: 'classes',
          id: membership.classId,
          overrideAccess: true,
          depth: 0,
        })) as unknown as typeof cls
      } catch {
        // Class deleted (kept-for-history policy aside, treat as no workspace).
        return undefined
      }

      const user = (await payload.findByID({
        collection: 'users',
        id,
        overrideAccess: true,
        depth: 0,
      })) as unknown as { id: string; name?: string }

      const subject = findSubjectVersion(cls.subjectVersionId)
      const record: StudentRecord = {
        id,
        classId: membership.classId,
        className: cls.name,
        subjectVersionId: cls.subjectVersionId,
        subjectName: subject?.subject ?? cls.subjectVersionId,
        examTarget: subject?.exam ?? 'oge',
        ownerId: cls.ownerId,
        displayName: user.name,
      }
      return record
    },

    async listAssignments(_studentId): Promise<StudentAssignment[]> {
      // Assignments arrive with ECLASS-23/24 — until then the honest answer is
      // an empty list (renders the E3 empty state, never fake data).
      return []
    },

    async setDisplayName(id, name) {
      await payload.update({
        collection: 'users',
        id,
        data: { name },
        overrideAccess: true,
      })
    },
  }
}
