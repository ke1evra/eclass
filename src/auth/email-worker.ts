/**
 * Email worker — ECLASS-67 outbox drainer, hardened in ECLASS-68.
 *
 * Concurrency (defect 2): a claim is a single conditional updateOne on
 * {_id, status:'pending', due} → {status:'claimed', leaseExpiresAt}. Two
 * parallel runEmailWorker calls can fetch the same candidate list, but only
 * ONE claim matches per job — the loser sees matchedCount 0 and moves on.
 * A crashed worker leaves the job in 'claimed'; once the lease expires the
 * job returns to 'pending' on the next run (defect 2b).
 *
 * Backoff (defect 3): on a send error the job goes back to 'pending' with
 * nextAttemptAt = now + 2^attempts * base — enforced by the due filter, and
 * provable with an injected clock (no "call it a few times" pseudo-backoff).
 *
 * Secrets hygiene (defect 1 + Дополнение): the body is SEALED (AES-256-GCM)
 * at issue time; the worker opens it only for the duration of the send, and
 * nulls it on both 'sent' and terminal 'failed'. lastError is scrubbed of
 * token-shaped runs before persisting.
 */
import type { Payload } from 'payload'
import type { EmailTransport } from '@/email/transport'
import { openEmailBody } from '@/email/crypto'

export interface Clock {
  now(): number
}

export interface WorkerOptions {
  payload: Payload
  transport: EmailTransport
  clock: Clock
  /** Max rows processed per run. Default 50. */
  limit?: number
  /** Per-job attempt cap before terminal `failed`. Default 5. */
  maxAttempts?: number
  /** Base for the exponential retry delay. Default 5_000 ms. */
  backoffBaseMs?: number
  /** How long a claim owns a job before the lease expires. Default 60_000 ms. */
  leaseMs?: number
}

export interface WorkerResult {
  processed: number
  sent: number
  failed: number
  /** Jobs skipped this run: not due yet or claimed by another worker. */
  skipped: number
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
  const backoffBaseMs = opts.backoffBaseMs ?? 5_000
  const leaseMs = opts.leaseMs ?? 60_000

  const jobs = payload.db.connection.collection('email-jobs')
  const now = clock.now()

  // Reclaim expired leases: a worker that died mid-send leaves 'claimed'
  // rows; once the lease is past, they become pending again (and due).
  await jobs.updateMany(
    { status: 'claimed', leaseExpiresAt: { $lt: now } },
    { $set: { status: 'pending' } },
  )

  // Candidates: pending AND due (nextAttemptAt absent = immediate).
  const candidates = await jobs
    .find({
      status: 'pending',
      $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }],
    })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray()

  let sent = 0
  let failed = 0
  let skipped = 0

  for (const candidate of candidates) {
    const id = candidate._id

    // ATOMIC CLAIM: conditional on still being pending-and-due. matchedCount 0
    // means another worker won this job between find and now.
    const claim = await jobs.updateOne(
      {
        _id: id,
        status: 'pending',
        $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }],
      },
      { $set: { status: 'claimed', claimedAt: now, leaseExpiresAt: now + leaseMs } },
    )
    if (claim.matchedCount !== 1) {
      skipped++
      continue
    }

    const job = candidate as unknown as {
      to: string
      subject: string
      body?: string | null
      attempts?: number | null
    }
    const attempts = (job.attempts ?? 0) + 1

    try {
      if (!job.body) throw new Error('job body already consumed')
      // Open the sealed body ONLY here, for the duration of the send.
      const plaintext = openEmailBody(job.body)
      await transport.send({ to: job.to, subject: job.subject, body: plaintext })
      await jobs.updateOne(
        { _id: id, status: 'claimed' },
        {
          $set: {
            status: 'sent',
            sentAt: clock.now(),
            // The sealed body (and with it any recoverable token) is gone.
            body: null,
            lastError: null,
            claimedAt: null,
            leaseExpiresAt: null,
          },
        },
      )
      sent++
    } catch (err) {
      const terminal = attempts >= maxAttempts
      const retryAt = now + Math.pow(2, attempts) * backoffBaseMs
      await jobs.updateOne(
        { _id: id, status: 'claimed' },
        {
          $set: {
            attempts,
            status: terminal ? 'failed' : 'pending',
            // Terminal or not, the sealed body never outlives delivery attempts
            // once the job is dead — on retry it is re-sealed by resend.
            ...(terminal ? { body: null } : {}),
            nextAttemptAt: terminal ? null : retryAt,
            lastError: scrubError(err),
            claimedAt: null,
            leaseExpiresAt: null,
          },
        },
      )
      failed++
    }
  }

  return { processed: candidates.length, sent, failed, skipped }
}
