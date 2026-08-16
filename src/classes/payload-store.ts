/**
 * Payload-backed ClassStore + InviteStore — ECLASS-56 (Stage A).
 *
 * The production adapters that replace the in-memory Maps at the application
 * boundary. Every method is a thin mapping between the domain store contracts
 * and the Payload Local API (overrideAccess: true — authorization lives in the
 * SERVICE layer via authorize(), which every route calls with the Actor from
 * the session cookie; the store never sees a client request).
 *
 * IDs: Payload/Mongo ObjectIds are exposed as hex strings (doc.id). `archivedAt`
 * maps to the optional number field (absent = active).
 */
import type { Payload, Where } from 'payload'
import type { ClassStore, StoredClass } from './service'
import { hashInviteCode, type InviteRecord, type InviteStore } from './invite'

type ClassDoc = {
  id: string
  ownerId: string
  subjectVersionId: string
  name: string
  archivedAt?: number | null
}

type InviteDoc = {
  id: string
  code: string
  classId: string
  ownerId: string
  createdAt: number
  expiresAt: number
  usedBy?: string | null
  usedAt?: number | null
  revoked: boolean
}

type MembershipDoc = { id: string; classId: string; studentId: string }

const toStoredClass = (d: ClassDoc): StoredClass => ({
  id: d.id,
  ownerId: d.ownerId,
  subjectVersionId: d.subjectVersionId,
  name: d.name,
  archivedAt: d.archivedAt ?? null,
})

const toInviteRecord = (d: InviteDoc): InviteRecord => ({
  code: d.code,
  classId: d.classId,
  ownerId: d.ownerId,
  createdAt: d.createdAt,
  expiresAt: d.expiresAt,
  usedBy: d.usedBy ?? undefined,
  usedAt: d.usedAt ?? undefined,
  revoked: d.revoked,
})

export function createPayloadClassStore(payload: Payload): ClassStore & InviteStore {
  return {
    async insertClass(c) {
      const doc = await payload.create({
        collection: 'classes',
        data: {
          ownerId: c.ownerId,
          subjectVersionId: c.subjectVersionId,
          name: c.name,
          archivedAt: c.archivedAt,
        },
        overrideAccess: true,
      })
      return toStoredClass(doc as unknown as ClassDoc)
    },

    async getClass(id) {
      try {
        const doc = await payload.findByID({
          collection: 'classes',
          id,
          overrideAccess: true,
          depth: 0,
        })
        return toStoredClass(doc as unknown as ClassDoc)
      } catch {
        // 404 APIError and malformed ids both mean "no such class" here; the
        // service turns undefined into not_found for every caller.
        return undefined
      }
    },

    async listClasses(ownerId, opts) {
      const where: Where = {
        ownerId: { equals: ownerId },
        ...(opts.includeArchived ? {} : { archivedAt: { exists: false } }),
      }
      const { docs } = await payload.find({
        collection: 'classes',
        where,
        limit: 100,
        overrideAccess: true,
        depth: 0,
        sort: '-createdAt',
      })
      return (docs as unknown as ClassDoc[]).map(toStoredClass)
    },

    async updateClass(id, patch) {
      const data: Record<string, unknown> = {}
      if (patch.name !== undefined) data.name = patch.name
      if (patch.archivedAt !== undefined) data.archivedAt = patch.archivedAt
      await payload.update({ collection: 'classes', id, data, overrideAccess: true })
    },

    async addStudent(classId, studentId) {
      await payload.create({
        collection: 'memberships',
        data: { classId, studentId },
        overrideAccess: true,
      })
    },

    async removeStudent(classId, studentId) {
      const { docs } = await payload.find({
        collection: 'memberships',
        where: { and: [{ classId: { equals: classId } }, { studentId: { equals: studentId } }] },
        limit: 1,
        overrideAccess: true,
        depth: 0,
      })
      const doc = docs[0] as MembershipDoc | undefined
      if (doc) {
        await payload.delete({ collection: 'memberships', id: doc.id, overrideAccess: true })
      }
    },

    async getRoster(classId) {
      const { docs } = await payload.find({
        collection: 'memberships',
        where: { classId: { equals: classId } },
        limit: 200,
        overrideAccess: true,
        depth: 0,
      })
      return (docs as unknown as MembershipDoc[]).map((d) => d.studentId)
    },

    async isMember(classId, studentId) {
      const { totalDocs } = await payload.count({
        collection: 'memberships',
        where: { and: [{ classId: { equals: classId } }, { studentId: { equals: studentId } }] },
        overrideAccess: true,
      })
      return totalDocs > 0
    },

    /** InviteStore.addMember — same membership row the class service writes. */
    async addMember(classId, studentId) {
      await payload.create({
        collection: 'memberships',
        data: { classId, studentId },
        overrideAccess: true,
      })
    },

    async insertInvite(inv) {
      await payload.create({
        collection: 'invites',
        data: {
          // ECLASS-57: at rest only the sha256 lives here — never the raw code.
          code: hashInviteCode(inv.code),
          classId: inv.classId,
          ownerId: inv.ownerId,
          createdAt: inv.createdAt,
          expiresAt: inv.expiresAt,
          revoked: inv.revoked,
        },
        overrideAccess: true,
      })
    },

    async getInvite(code) {
      const { docs } = await payload.find({
        collection: 'invites',
        where: { code: { equals: hashInviteCode(code) } },
        limit: 1,
        overrideAccess: true,
        depth: 0,
      })
      const doc = docs[0] as unknown as InviteDoc | undefined
      return doc ? toInviteRecord(doc) : undefined
    },

    async markUsed(code, studentId) {
      const { docs } = await payload.find({
        collection: 'invites',
        where: { code: { equals: hashInviteCode(code) } },
        limit: 1,
        overrideAccess: true,
        depth: 0,
      })
      const doc = docs[0] as InviteDoc | undefined
      if (doc) {
        await payload.update({
          collection: 'invites',
          id: doc.id,
          data: { usedBy: studentId, usedAt: Date.now() },
          overrideAccess: true,
        })
      }
    },

    async revokeInvite(code) {
      const { docs } = await payload.find({
        collection: 'invites',
        where: { code: { equals: hashInviteCode(code) } },
        limit: 1,
        overrideAccess: true,
        depth: 0,
      })
      const doc = docs[0] as InviteDoc | undefined
      if (doc) {
        await payload.update({
          collection: 'invites',
          id: doc.id,
          data: { revoked: true },
          overrideAccess: true,
        })
      }
    },

    async getClassOwner(classId) {
      const cls = await this.getClass(classId)
      return cls?.ownerId
    },
  }
}
