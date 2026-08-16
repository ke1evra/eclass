import type { CollectionConfig } from 'payload'

/**
 * EmailJobs — ECLASS-67 outbox, hardened in ECLASS-68.
 *
 * Delivery lifecycle: pending → claimed (atomic lease) → sent | pending(retry)
 * → failed(terminal). Worker concurrency is safe by construction: a claim is
 * a conditional updateOne on {status: pending, due}, so exactly one worker
 * owns a job at a time; a crashed worker's lease expiry returns the job to
 * pending. Retries honor nextAttemptAt (exponential backoff), and the body —
 * which carries the raw bearer token SEALED with AES-256-GCM — is nulled on
 * both sent and terminal failed (nothing sensitive outlives delivery).
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
      // AES-256-GCM sealed body (`v1:…`); opened only inside the worker for
      // the duration of the send. Nulled once the job is terminal.
      name: 'body',
      type: 'text',
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      options: ['pending', 'claimed', 'sent', 'failed'],
    },
    { name: 'attempts', type: 'number', defaultValue: 0 },
    {
      // Not-before timestamp (epoch ms): the worker takes a job only when
      // nextAttemptAt <= now. Implements REAL backoff between retries.
      name: 'nextAttemptAt',
      type: 'number',
    },
    { name: 'claimedAt', type: 'number' },
    { name: 'leaseExpiresAt', type: 'number' },
    {
      // Scrubbed transport error (no token-like patterns) for diagnostics.
      name: 'lastError',
      type: 'text',
    },
    { name: 'createdAt', type: 'number', required: true },
    { name: 'sentAt', type: 'number' },
  ],
  indexes: [{ fields: ['status'] }, { fields: ['createdAt'] }, { fields: ['nextAttemptAt'] }],
}
