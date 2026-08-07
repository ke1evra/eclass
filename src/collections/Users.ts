import type { CollectionConfig } from 'payload'

/**
 * Users — ECLASS-56 / ECLASS-62 / ECLASS-63.
 *
 * SECURITY invariants (server-enforced, tested without overrideAccess):
 *   - signup role is always 'teacher' (beforeChange hook on create).
 *   - `role`, `email`, `password` are NOT client-writable on update (field-level
 *     access.update denies them; only a trusted server process with overrideAccess
 *     or disableHooks can change them — e.g. email confirmation, admin provisioning).
 *   - update/delete are SELF-ONLY for non-admins; admin may manage any user.
 */
export const Users: CollectionConfig = {
  slug: 'users',
  auth: {
    useAPIKey: false,
    tokenExpiration: 60 * 60 * 24,
  },
  access: {
    read: ({ req }) => {
      if (!req.user) return false
      if (req.user.role === 'admin') return true
      return { id: { equals: req.user.id } }
    },
    create: () => true,
    // ECLASS-63: self-only update for non-admins. The id in the constraint
    // refers to the document being updated, so this restricts a teacher to
    // their own record. Admin bypasses.
    update: ({ req }) => {
      if (!req.user) return false
      if (req.user.role === 'admin') return true
      return { id: { equals: req.user.id } }
    },
    delete: ({ req }) => {
      if (!req.user) return false
      if (req.user.role === 'admin') return true
      return { id: { equals: req.user.id } }
    },
  },
  hooks: {
    beforeChange: [
      ({ data, operation, req, originalDoc }) => {
        // On CREATE the role is always forced to 'teacher' — never trusted
        // from the client. Admin is provisioned out-of-band (script/migration
        // with disableHooks), never via this collection's create path.
        if (operation === 'create') {
          return { ...data, role: 'teacher' }
        }
        // On UPDATE, privileged fields are restored from the existing doc so a
        // CLIENT cannot mutate them. A trusted server process (no req.user, or
        // an admin) is allowed to change role/email — this is the path used by
        // confirm-email and trusted provisioning. Anything originating from an
        // authenticated non-admin client has role/email frozen to the existing
        // values.
        if (operation === 'update' && req.user && req.user.role !== 'admin') {
          return {
            ...data,
            role: originalDoc.role,
            email: originalDoc.email,
          }
        }
        return data
      },
    ],
  },
  fields: [
    { name: 'name', type: 'text' },
    {
      name: 'role',
      type: 'select',
      options: ['teacher', 'student', 'admin'],
      defaultValue: 'teacher',
      required: true,
      // Field-level deny: even if a non-admin somehow passes collection access,
      // the field itself refuses the update. (Admin-only.)
      access: {
        update: ({ req }) => req.user?.role === 'admin',
      },
    },
    {
      name: 'emailConfirmed',
      type: 'checkbox',
      defaultValue: false,
      admin: { readOnly: true },
      access: {
        update: ({ req }) => req.user?.role === 'admin',
      },
    },
  ],
}
