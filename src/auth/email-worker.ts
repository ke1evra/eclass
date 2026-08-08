/**
 * Email worker — ECLASS-67 outbox drainer.
 *
 * The signup flow writes user + a pending `email-jobs` row in one transaction
 * but NEVER calls the transport (email delivery cannot be rolled back by a DB
 * transaction). This worker is the separate delivery side: it drains `pending`
 * rows, sends each via the transport, and marks the row `sent` or retries with
 * backoff until `attempts >= maxAttempts` → `failed`.
 *
 * Invocation:
 *   - Tests call `runEmailWorker({ payload, transport, clock })` directly and
 *     synchronously before asserting on the outbox.
 *   - Production runs it via `/api/internal/email-worker` (X-Worker-Secret),
 *     driven by an external cron every ~30s.
 *
 * `scrubError` strips any long base64url-looking run from the captured error
 * message before it is persisted to `email-jobs.lastError` — defensive, in
 * case a future transport accidentally echoes the body (which carries the raw
 * bearer token).
 */
import type { Payload } from 'payload'
import type { EmailTransport } from '@/email/transport'

export interface Clock {
  now(): number
}

export interface WorkerOptions {
  payload: Payload
  transport: EmailTransport
  clock: Clock
  /** Max rows processed per run. Default 50. */
  limit?: number
  /** Per-job attempt cap before `failed`. Default 5. */
  maxAttempts?: number
}

export interface WorkerResult {
  processed: number
  sent: number
  failed: number
}

/**
 * Strip any run of ≥20 base64url characters from a string. Guards against a
 * transport error that echoes the email body (which carries the raw bearer
 * token) into the persisted `lastError` field.
 */
export function scrubError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]').slice(0, 1000)
}

export async function runEmailWorker(opts: WorkerOptions): Promise<WorkerResult> {
  const { payload, transport, clock } = opts
  const limit = opts.limit ?? 50
  const maxAttempts = opts.maxAttempts ?? 5

  const { docs } = await payload.find({
    collection: 'email-jobs',
    where: { status: { equals: 'pending' } },
    limit,
    overrideAccess: true,
    sort: 'createdAt',
  })

  let sent = 0
  let failed = 0

  for (const job of docs) {
    const j = job as {
      id: string
      to: string
      subject: string
      body: string
      attempts?: number | null
    }
    try {
      await transport.send({ to: j.to, subject: j.subject, body: j.body })
      await payload.update({
        collection: 'email-jobs',
        id: j.id,
        data: { status: 'sent', sentAt: clock.now() },
        overrideAccess: true,
      })
      sent++
    } catch (err) {
      const attempts = (j.attempts ?? 0) + 1
      await payload.update({
        collection: 'email-jobs',
        id: j.id,
        data: {
          attempts,
          status: attempts >= maxAttempts ? 'failed' : 'pending',
          lastError: scrubError(err),
        },
        overrideAccess: true,
      })
      failed++
    }
  }

  return { processed: docs.length, sent, failed }
}
