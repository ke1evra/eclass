import type { CollectionConfig } from 'payload'

/**
 * Memberships — ECLASS-56.
 *
 * The roster link between a student and a class. Uniqueness on
 * (classId, studentId) prevents duplicate membership at the DB level — the
 * atomic invite acceptance (ECLASS-57) relies on this unique index to make a
 * duplicate-join a no-op/insert-failure rather than a second row.
 *
 * Access: a teacher can read the memberships of classes they own; a student
 * can read only their own membership rows (so they can see their class). All
 * mutation goes through server-side invite/move flows, never direct client
 * writes.
 */
export const Memberships: CollectionConfig = {
  slug: 'memberships',
  access: {
    read: ({ req }) => {
      if (!req.user) return false
      if (req.user.role === 'admin') return true
      if (req.user.role === 'teacher') {
        // Teachers see memberships for classes they own. The class-ownership
        // join is enforced at the service layer; here we allow the read and the
        // service filters by owned classIds.
        return true
      }
      if (req.user.role === 'student') return { studentId: { equals: req.user.id } }
      return false
    },
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'classId', type: 'text', required: true },
    { name: 'studentId', type: 'text', required: true },
  ],
  indexes: [
    { fields: ['classId', 'studentId'], unique: true },
  ],
}
