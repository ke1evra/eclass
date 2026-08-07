import { beforeEach, describe, expect, it } from 'vitest'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'

/**
 * ECLASS-62 / ECLASS-63 — Payload access-control vulnerabilities.
 *
 * All assertions exercise the REAL Payload Local API WITHOUT overrideAccess
 * (access functions + hooks run), so they prove the boundary, not a mock.
 *
 * Coverage:
 *   signup   — anonymous cannot self-escalate role=admin
 *   update   — teacher cannot change own/other's role, email, password
 *   delete   — teacher cannot delete another user
 *   classes  — ownerId immutable on update (cannot reassign tenant)
 *   memberships — teacher cannot read other tenant's rosters
 */
integrationSuite('ECLASS-62/63: Payload access control', () => {
  beforeEach(async () => {
    await clearData()
  })

  describe('1. role escalation on signup (no overrideAccess)', () => {
    it('an ANONYMOUS caller submitting role=admin is stored as teacher', async () => {
      const p = await getPayloadSingleton()
      // Real boundary: anonymous (no user), overrideAccess:false — Payload's
      // create access returns true for signup, but the beforeChange hook must
      // force role=teacher regardless of the client value.
      const created = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('anon'), password: 'longpass123', role: 'admin' },
        overrideAccess: false,
      })
      expect(created.role).toBe('teacher')
    })
  })

  describe('2. self/other update — role escalation via update', () => {
    it('a teacher CANNOT update their own role to admin', async () => {
      const p = await getPayloadSingleton()
      const teacher = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('self'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      // Attempt self-escalation through the real boundary.
      try {
        const updated = await p.update({
          collection: 'users',
          id: teacher.id,
          data: { role: 'admin' },
          user: teacher,
          overrideAccess: false,
        })
        // If the update is permitted, the role must NOT have changed.
        expect(updated.role).toBe('teacher')
      } catch (err) {
        // A Forbidden/NotAllowed is the other acceptable outcome.
        expect(String(err)).toMatch(/not allowed|forbidden|403/i)
      }
      // Verify persisted state unchanged.
      const refetched = await p.findByID({ collection: 'users', id: teacher.id, overrideAccess: true })
      expect(refetched.role).toBe('teacher')
    })

    it('a teacher CANNOT update ANOTHER user at all', async () => {
      const p = await getPayloadSingleton()
      const a = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('a'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const b = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('b'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const originalName = b.name
      await expect(
        p.update({
          collection: 'users',
          id: b.id,
          data: { name: 'hijacked' },
          user: a,
          overrideAccess: false,
        }),
      ).rejects.toThrow(/not allowed|forbidden|403/i)
      const refetched = await p.findByID({ collection: 'users', id: b.id, overrideAccess: true })
      expect(refetched.name).toBe(originalName)
    })

    it('a teacher CANNOT change another user\'s email or password', async () => {
      const p = await getPayloadSingleton()
      const a = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('a'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const bEmail = uniqueEmail('b')
      const b = await p.create({
        collection: 'users',
        data: { email: bEmail, password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      await expect(
        p.update({
          collection: 'users',
          id: b.id,
          data: { email: 'stolen@eclasstest.ru', password: 'newpass999' },
          user: a,
          overrideAccess: false,
        }),
      ).rejects.toThrow(/not allowed|forbidden|403/i)
      const refetched = await p.findByID({ collection: 'users', id: b.id, overrideAccess: true })
      expect(refetched.email).toBe(bEmail)
    })
  })

  describe('3. delete — teacher cannot delete another user', () => {
    it('a teacher CANNOT delete ANOTHER user', async () => {
      const p = await getPayloadSingleton()
      const a = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('a'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const b = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('b'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      await expect(
        p.delete({
          collection: 'users',
          id: b.id,
          user: a,
          overrideAccess: false,
        }),
      ).rejects.toThrow(/not allowed|forbidden|403/i)
      // b still exists.
      const refetched = await p.findByID({ collection: 'users', id: b.id, overrideAccess: true })
      expect(refetched.id).toBe(b.id)
    })
  })

  describe('4. classes — ownerId immutable after create', () => {
    it('a teacher CANNOT reassign their class to another ownerId via update', async () => {
      const p = await getPayloadSingleton()
      const a = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('a'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const b = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('b'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const cls = await p.create({
        collection: 'classes',
        data: { subjectVersionId: 'subj', name: 'A-class' },
        user: a,
        overrideAccess: false,
      })
      expect(cls.ownerId).toBe(a.id)
      // Attempt to reassign ownership to b through update.
      const updated = await p.update({
        collection: 'classes',
        id: cls.id,
        data: { ownerId: b.id },
        user: a,
        overrideAccess: false,
      })
      expect(updated.ownerId).toBe(a.id)
    })
  })

  describe('5. memberships leak across tenants', () => {
    it('teacher A cannot read memberships of teacher B\'s class', async () => {
      const p = await getPayloadSingleton()
      const a = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('a'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const b = await p.create({
        collection: 'users',
        data: { email: uniqueEmail('b'), password: 'longpass123', role: 'teacher' },
        overrideAccess: true,
      })
      const classB = await p.create({
        collection: 'classes',
        data: { subjectVersionId: 'subj', name: 'B-class' },
        user: b,
        overrideAccess: false,
      })
      await p.create({
        collection: 'memberships',
        data: { classId: classB.id, studentId: 'stu-b-1' },
        overrideAccess: true,
      })

      const found = await p.find({
        collection: 'memberships',
        user: a,
        overrideAccess: false,
      })
      expect(found.docs.filter((m) => m.classId === classB.id)).toHaveLength(0)
    })
  })
})
