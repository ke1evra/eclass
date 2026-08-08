import type { CollectionConfig } from 'payload'

/**
 * EmailJobs — ECLASS-67 outbox.
 *
 * Pending confirmation emails awaiting delivery. The signup flow writes a user
 * + an `email-jobs` row inside ONE Mongo transaction (ECLASS-67 v2): if either
 * side fails, both roll back, so a user is never left without a deliverable
 * confirmation link and a raw token is never orphaned.
 *
 * A background worker (`runEmailWorker`, triggered via
 * `/api/internal/email-worker`) drains `pending` rows: sends via the transport,
 * marks `sent`, or retries with backoff until `attempts >= maxAttempts` →
 * `failed`. The `body` field carries the raw bearer token until delivery and
 * is server-only; `lastError` is scrubbed (no token-like patterns).
 *
 * Deny-by-default: only the server (Local API, overrideAccess) reads/writes.
 */
export const EmailJobs: CollectionConfig = {
  slug: 'email-jobs',
  access: {
    read: () => false,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'userId', type: 'text', required: true, index: true },
    { name: 'to', type: 'text', required: true },
    { name: 'subject', type: 'text', required: true },
    {
      // Carries the raw bearer confirmation token until the worker delivers
      // the email. Server-only; never returned to any client.
      name: 'body',
      type: 'text',
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      options: ['pending', 'sent', 'failed'],
    },
    { name: 'attempts', type: 'number', defaultValue: 0 },
    {
      // Scrubbed transport error (no token-like patterns) for diagnostics.
      name: 'lastError',
      type: 'text',
    },
    { name: 'createdAt', type: 'number', required: true },
    { name: 'sentAt', type: 'number' },
  ],
  indexes: [{ fields: ['status'] }, { fields: ['createdAt'] }],
}
