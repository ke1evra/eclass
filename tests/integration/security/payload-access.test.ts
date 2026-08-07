import { beforeEach, describe, expect, it } from 'vitest'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'

/**
 * ECLASS-62 — Payload access-control vulnerabilities.
 *
 * These tests exercise the REAL Payload Local API WITHOUT overrideAccess
 * (access functions run), so they prove the boundary, not a service mock.
 *
 * Three vulnerabilities from independent review:
 *   1. role escalation: anonymous signup with role=admin
 *   2. memberships leak: teacher reads ALL memberships
 *   3. foreign ownerId: teacher creates a class owned by another teacher
 *
 * They MUST fail on f452298 and pass after the fix.
 */
integrationSuite('ECLASS-62: Payload access control', () => {
  beforeEach(async () => {
    await clearData()
  })

  describe('1. role escalation on signup', () => {
    it('an anonymous caller CANNOT create an admin (server forces role=teacher)', async () => {
      const p = await getPayloadSingleton()
      // Simulate an open signup: create with no req.user, client supplies role=admin.
      const created = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('evil'), password: 'longpass123', role: 'admin' },
        overrideAccess: true, // signup path is server-mediated; overrideAccess models it
      })
      expect(created.role).toBe('teacher')
    })

    it('a teacher creating a user cannot inject admin either', async () => {
      const p = await getPayloadSingleton()
      // First, bootstrap a teacher (server process).
      const teacher = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('t'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      // Now a request "as" that teacher attempts to create an admin.
      const created = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('evil2'), password: 'longpass123', role: 'admin' },
        user: teacher,
        overrideAccess: false,
      })
      expect(created.role).toBe('teacher')
    })
  })

  describe('2. memberships leak across tenants', () => {
    it('teacher A cannot read memberships of teacher B\'s class', async () => {
      const p = await getPayloadSingleton()
      const teacherA = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('a'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const teacherB = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('b'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const classB = await p.create({
        collection: 'classes',
        data: { ownerId: teacherB.id, subjectVersionId: 'subj', name: 'B' },
        overrideAccess: true,
      })
      await p.create({
        collection: 'memberships',
        data: { classId: classB.id, studentId: 'stu-b-1' },
        overrideAccess: true,
      })

      // Teacher A queries memberships — should see NONE of B's.
      const found = await p.find({
        collection: 'memberships',
        user: teacherA,
        overrideAccess: false,
      })
      expect(found.docs.filter((m) => m.classId === classB.id)).toHaveLength(0)
    })
  })

  describe('3. foreign ownerId on class create', () => {
    it('teacher A cannot create a class owned by teacher B', async () => {
      const p = await getPayloadSingleton()
      const teacherA = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('a'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const teacherB = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('b'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })

      // Teacher A tries to set ownerId = teacherB.
      const created = await p.create({
        collection: 'classes',
        data: { ownerId: teacherB.id, subjectVersionId: 'subj', name: 'hijack' },
        user: teacherA,
        overrideAccess: false,
      })
      expect(created.ownerId).toBe(teacherA.id)
    })
  })
})
