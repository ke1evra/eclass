import type { CollectionConfig } from 'payload'

/**
 * Sessions — ECLASS-56.
 *
 * Persistent server-side sessions keyed by an opaque cookie value. Revocation
 * is a row update (revoked=true); expiry is checked by the resolver against
 * `expiresAt`. Survives process restart — the core requirement of ECLASS-56.
 *
 * No client can list or read sessions directly: access is deny-by-default and
 * only the server (no req.user) writes them through the auth flow.
 */
export const Sessions: CollectionConfig = {
  slug: 'sessions',
  access: {
    // Sessions are never exposed to any authenticated user; only the server
    // (operating without req.user, via Local API) reads them.
    read: () => false,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'sessionId', type: 'text', required: true, unique: true },
    { name: 'userId', type: 'text', required: true },
    {
      name: 'role',
      type: 'select',
      required: true,
      options: ['teacher', 'student'],
    },
    { name: 'expiresAt', type: 'number', required: true },
    { name: 'revoked', type: 'checkbox', defaultValue: false },
  ],
  indexes: [
    { fields: ['userId'] },
  ],
}
