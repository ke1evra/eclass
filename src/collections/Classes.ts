import type { CollectionConfig } from 'payload'

/**
 * Classes — ECLASS-56.
 *
 * Tenant boundary. A class is owned by exactly one teacher (ownerId). The
 * access policy enforces owner-only read/write; cross-tenant reads return
 * nothing (the policy returns false → Payload yields no docs, so existence
 * does not leak).
 *
 * Soft-archiving preserves history (ECLASS-14): archivedAt marks a class
 * hidden from the default list, but the row stays for submission history.
 */
export const Classes: CollectionConfig = {
  slug: 'classes',
  access: {
    // Owner-only: a teacher sees only their own classes. Students see nothing
    // here directly — they reach their class through the student workspace,
    // which is a separate scoping path.
    read: ({ req }) => {
      if (!req.user) return false
      if (req.user.role === 'admin') return true
      if (req.user.role === 'teacher') return { ownerId: { equals: req.user.id } }
      return false
    },
    create: ({ req }) => req.user?.role === 'teacher' || req.user?.role === 'admin',
    update: ({ req }) => {
      if (!req.user) return false
      if (req.user.role === 'admin') return true
      if (req.user.role === 'teacher') return { ownerId: { equals: req.user.id } }
      return false
    },
    delete: ({ req }) => {
      if (!req.user) return false
      if (req.user.role === 'admin') return true
      if (req.user.role === 'teacher') return { ownerId: { equals: req.user.id } }
      return false
    },
  },
  fields: [
    { name: 'ownerId', type: 'text', required: true },
    { name: 'subjectVersionId', type: 'text', required: true },
    { name: 'name', type: 'text', required: true },
    { name: 'archivedAt', type: 'number' },
  ],
  indexes: [{ fields: ['ownerId'] }],
}
