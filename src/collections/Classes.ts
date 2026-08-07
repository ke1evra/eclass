import type { CollectionConfig } from 'payload'

/**
 * Classes — ECLASS-56 / ECLASS-62.
 *
 * Tenant boundary. SECURITY (ECLASS-62): the `ownerId` is SERVER-SET from the
 * authenticated user via a beforeChange hook on create — any client-supplied
 * value is overwritten. A teacher can therefore never create a class owned by
 * someone else.
 *
 * Soft-archiving preserves history (ECLASS-14).
 */
export const Classes: CollectionConfig = {
  slug: 'classes',
  access: {
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
  hooks: {
    beforeChange: [
      ({ data, operation, req }) => {
        // ECLASS-62: ownerId is derived from the authenticated user on create,
        // never from the request body. The teacher becomes the owner by fact
        // of being logged in, not by claiming an id.
        if (operation === 'create' && req.user?.id) {
          return { ...data, ownerId: req.user.id }
        }
        return data
      },
    ],
  },
  fields: [
    {
      name: 'ownerId',
      type: 'text',
      required: true,
      // Client cannot set this — the hook overrides it on create, and admin
      // is readOnly to prevent edits.
      admin: { readOnly: true },
    },
    { name: 'subjectVersionId', type: 'text', required: true },
    { name: 'name', type: 'text', required: true },
    { name: 'archivedAt', type: 'number' },
  ],
  indexes: [{ fields: ['ownerId'] }],
}
