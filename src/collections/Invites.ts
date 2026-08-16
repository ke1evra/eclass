import type { CollectionConfig } from 'payload'

/**
 * Invites — ECLASS-56 / ECLASS-57.
 *
 * Opaque single-use class invitations. The code carries NO class/teacher
 * identifiers (ECLASS-15 acceptance); redemption is atomic (ECLASS-57):
 *   - claim: conditional updateOne { code, revoked:false, expiresAt>$now,
 *     usedBy:null } → exactly one winner under concurrency;
 *   - the membership insert and the claim run in ONE Mongo transaction, so an
 *     abort leaves neither a consumed invite nor an orphan membership.
 *
 * Access is deny-by-default for every client: invites are minted/read/claimed
 * only by the server via the Local API.
 */
export const Invites: CollectionConfig = {
  slug: 'invites',
  access: {
    read: () => false,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'code', type: 'text', required: true, unique: true },
    { name: 'classId', type: 'text', required: true },
    { name: 'ownerId', type: 'text', required: true },
    { name: 'createdAt', type: 'number', required: true },
    { name: 'expiresAt', type: 'number', required: true },
    { name: 'usedBy', type: 'text' },
    { name: 'usedAt', type: 'number' },
    { name: 'revoked', type: 'checkbox', defaultValue: false },
  ],
  indexes: [{ fields: ['classId'] }],
}
