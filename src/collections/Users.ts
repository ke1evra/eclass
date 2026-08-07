import type { CollectionConfig } from 'payload'

/**
 * Users — ECLASS-56 / ECLASS-62.
 *
 * The single auth collection. SECURITY (ECLASS-62):
 *   - `role` is SERVER-SET. A beforeChange hook forces `role = 'teacher'` on
 *     every create, ignoring any client-supplied value. Admin can only be
 *     created by a trusted bootstrap/server process using overrideAccess (the
 *     hook still runs, so bootstrap must use a dedicated path that bypasses
 *     collection hooks — e.g. a migration or an admin script with
 *     `disableHooks`).
 *   - `emailConfirmed` is not client-writable.
 *
 * Access is server-side and default-deny: a user reads only themselves.
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
      return { id: { equals: req.user.id } }
    },
    create: () => true,
    update: ({ req }) => req.user?.id !== undefined,
    delete: ({ req }) => req.user?.id !== undefined,
  },
  hooks: {
    beforeChange: [
      ({ data, operation }) => {
        // ECLASS-62: the role is NEVER trusted from the client on create.
        // Signup always yields a teacher; admin is provisioned out-of-band
        // (migration / trusted script) — never through this collection's
        // create path with a client-supplied role.
        if (operation === 'create') {
          return { ...data, role: 'teacher' }
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
    },
    {
      name: 'emailConfirmed',
      type: 'checkbox',
      defaultValue: false,
      admin: { readOnly: true },
      access: {
        update: () => false,
      },
    },
  ],
}
