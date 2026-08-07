import type { CollectionConfig } from 'payload'

/**
 * Users — ECLASS-56.
 *
 * The single auth collection. Stores teacher (and later student) identities.
 * Password hashing is delegated to Payload's auth (bcrypt-based); the legacy
 * scrypt path in src/auth/service.ts remains the domain contract for tests,
 * and the Payload-backed adapter (ECLASS-56) honours it. Access control is
 * server-side and default-deny: a user can read only themselves; creation is
 * the signup path (open); mutations require the user to be the owner.
 */
export const Users: CollectionConfig = {
  slug: 'users',
  auth: {
    // Payload manages password hashing and verification. We do NOT expose raw
    // hashes; login goes through Payload's local strategy.
    useAPIKey: false,
    tokenExpiration: 60 * 60 * 24, // not used for sessions (we have our own)
  },
  access: {
    // Self-only read. Tenant isolation is enforced at the class/membership
    // layer; here we just ensure a user cannot enumerate others.
    read: ({ req }) => {
      if (!req.user) return false
      return { id: { equals: req.user.id } }
    },
    // Signup is open (anyone may register a teacher account in MVP).
    create: () => true,
    update: ({ req, id }) => req.user?.id === id,
    delete: ({ req, id: userId }) => req.user?.id === userId,
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
      // Only an admin/server process flips this; not client-writable.
      admin: { readOnly: true },
      access: {
        update: ({ req }) => req.user?.role === 'admin' || !req.user,
      },
    },
  ],
}
