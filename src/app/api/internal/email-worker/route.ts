import { NextRequest, NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { runEmailWorker } from '@/auth/email-worker'
import { getEmailTransport } from '@/email/transport'

/**
 * POST /api/internal/email-worker — ECLASS-67 outbox drainer trigger.
 *
 * Production cron hits this endpoint every ~30s with `X-Worker-Secret`. The
 * secret gates the endpoint so an external actor cannot spam it (each call
 * drains the outbox, so uncontrolled triggering is a low-severity DoS at
 * worst, but the secret also prevents accidental invocation).
 *
 * Tests do not call this route — they invoke `runEmailWorker` directly with an
 * in-memory outbox transport. This route exists purely for the production
 * scheduler.
 *
 * 503 when the worker is not configured (no EMAIL_WORKER_SECRET), 401 on a
 * mismatched secret, 200 with the run summary otherwise.
 */
export async function POST(req: NextRequest) {
  const expected = process.env.EMAIL_WORKER_SECRET
  if (!expected) {
    return NextResponse.json({ ok: false, code: 'worker_not_configured' }, { status: 503 })
  }
  const provided = req.headers.get('x-worker-secret')
  if (provided !== expected) {
    return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })
  }

  const payload = await getPayload({ config })
  const result = await runEmailWorker({
    payload,
    transport: getEmailTransport(),
    clock: { now: () => Date.now() },
  })
  return NextResponse.json({ ok: true, ...result })
}
