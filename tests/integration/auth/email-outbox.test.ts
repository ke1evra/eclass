import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { Payload } from 'payload'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { POST as signupRoute } from '@/app/api/auth/signup/route'
import { POST as confirmRoute } from '@/app/api/auth/confirm/route'
import { createEmailConfirm } from '@/auth/email-confirm'
import { runEmailWorker } from '@/auth/email-worker'
import { openEmailBody, sealEmailBody } from '@/email/crypto'
import type { EmailMessage, EmailTransport } from '@/email/transport'

/**
 * ECLASS-68 — outbox hardening proofs.
 *
 *   (2) parallel workers never double-send (atomic claim); a crashed worker's
 *       expired lease returns the job to pending;
 *   (3) backoff is enforced by nextAttemptAt, not by call spacing;
 *   (1+Дополнение) the body is SEALED at rest (AES-256-GCM) and consumed on
 *       both sent and terminal failed;
 *   (5) resend is job-first with a compensating delete: on a user-update
 *       failure the old token stays valid and no orphan job remains;
 *   (4) compensating actions LOG their own failures.
 */

class Outbox implements EmailTransport {
  readonly sent: EmailMessage[] = []
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg)
  }
}

class FailingTransport implements EmailTransport {
  constructor(private readonly message = 'smtp down') {}
  async send(): Promise<void> {
    throw new Error(this.message)
  }
}

const jsonReq = (url: string, body: unknown): NextRequest =>
  new NextRequest(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const jobDoc = async (p: Payload, email: string) =>
  p.db.connection.collection('email-jobs').findOne({ to: email })

integrationSuite('ECLASS-68: email outbox hardening', () => {
  beforeEach(clearData)

  it('(2) two PARALLEL workers send a pending job exactly once', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('race')
    await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))

    const a = new Outbox()
    const b = new Outbox()
    const [ra, rb] = await Promise.all([
      runEmailWorker({ payload: p, transport: a, clock: { now: () => Date.now() } }),
      runEmailWorker({ payload: p, transport: b, clock: { now: () => Date.now() } }),
    ])

    expect(a.sent.length + b.sent.length).toBe(1)
    expect(ra.sent + rb.sent).toBe(1)
    expect(ra.skipped + rb.skipped).toBeGreaterThanOrEqual(1)

    const doc = await jobDoc(p, email)
    expect(doc?.status).toBe('sent')
    // attempts stayed at 0/1 — the loser never touched the job's counters.
    expect(doc?.attempts).toBeLessThanOrEqual(1)
  })

  it('(2b) an expired lease returns a claimed job to pending and it delivers', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('lease')
    await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))

    // Simulate a worker that died mid-claim: status claimed, lease in the past.
    await p.db.connection.collection('email-jobs').updateOne(
      { to: email },
      { $set: { status: 'claimed', claimedAt: Date.now() - 120_000, leaseExpiresAt: Date.now() - 60_000 } },
    )

    const outbox = new Outbox()
    const result = await runEmailWorker({ payload: p, transport: outbox, clock: { now: () => Date.now() } })
    expect(result.sent).toBe(1)
    expect((await jobDoc(p, email))?.status).toBe('sent')
  })

  it('(3) a job with a future nextAttemptAt is not taken until it is due', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('due')
    await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))
    await p.db.connection.collection('email-jobs').updateOne(
      { to: email },
      { $set: { nextAttemptAt: Date.now() + 60_000 } },
    )

    const outbox = new Outbox()
    const now = () => Date.now()
    const skipped = await runEmailWorker({ payload: p, transport: outbox, clock: { now } })
    expect(skipped.processed).toBe(0)
    expect(outbox.sent).toHaveLength(0)

    await p.db.connection.collection('email-jobs').updateOne(
      { to: email },
      { $set: { nextAttemptAt: Date.now() - 1 } },
    )
    const due = await runEmailWorker({ payload: p, transport: outbox, clock: { now } })
    expect(due.sent).toBe(1)
  })

  it('(1) the body is sealed at rest and consumed after delivery', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('seal')
    await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))

    const pending = await jobDoc(p, email)
    expect(String(pending?.body).startsWith('v1:')).toBe(true)
    const plaintext = openEmailBody(String(pending?.body))
    const token = plaintext.match(/token=([A-Za-z0-9_-]+)/)?.[1]!
    expect(String(pending?.body)).not.toContain(token)
    // The whole DB row contains no trace of the raw token.
    expect(JSON.stringify(pending)).not.toContain(token)

    const outbox = new Outbox()
    await runEmailWorker({ payload: p, transport: outbox, clock: { now: () => Date.now() } })
    expect(outbox.sent[0]!.body).toContain(token) // transport sees plaintext

    const sent = await jobDoc(p, email)
    expect(sent?.body ?? null).toBeNull()
  })

  it('(5) resend on a user-update failure: job deleted, OLD token still confirms', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('resend-atomic')
    const outbox = new Outbox()
    const { token: oldToken } = await (async () => {
      await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))
      await runEmailWorker({ payload: p, transport: outbox, clock: { now: () => Date.now() } })
      const token = outbox.sent[0]!.body.match(/token=([A-Za-z0-9_-]+)/)![1]!
      return { token }
    })()

    // Fail ONLY the users update inside resend (the job create must succeed
    // first — that ordering is the fix under test).
    const boom = new Error('user update failed')
    const failing = new Proxy(p as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop !== 'update') return Reflect.get(target, prop)
        const orig = target.update as (args: { collection?: string }) => Promise<unknown>
        return (args: { collection?: string }) => {
          if (args?.collection === 'users') return Promise.reject(boom)
          return orig.apply(target, [args])
        }
      },
    }) as unknown as Payload

    const confirm = createEmailConfirm({
      payload: failing,
      clock: { now: () => Date.now() },
      ttlMs: 24 * 60 * 60 * 1000,
    })
    await expect(confirm.resend(email)).rejects.toThrow('user update failed')

    // Compensating delete removed the job with the undeliverable token; the
    // only row left is the ORIGINAL already-sent one (historical, body null).
    const jobs = await p.find({
      collection: 'email-jobs',
      where: { to: { equals: email } },
      overrideAccess: true,
    })
    expect(jobs.totalDocs).toBe(1)
    const survivor = jobs.docs[0] as unknown as { status: string; body?: string | null }
    expect(survivor.status).toBe('sent')
    expect(survivor.body ?? null).toBeNull()

    // …and the OLD token still works — the user's hash was never swapped.
    const confirmed = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token: oldToken }))
    expect(confirmed.status).toBe(200)
  })

  it('(4) a failing compensating delete is LOGGED, and the original error surfaces', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('complog')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // users-create succeeds, email-jobs create fails, users-DELETE fails too.
      const jobBoom = new Error('email-jobs insert failed')
      const deleteBoom = new Error('delete also failed')
      const failing = new Proxy(p as unknown as Record<string | symbol, unknown>, {
        get(target, prop) {
          if (prop === 'create') {
            const orig = target.create as (args: { collection?: string }) => Promise<unknown>
            return async (args: { collection?: string }) => {
              if (args?.collection === 'email-jobs') throw jobBoom
              return orig.apply(target, [args])
            }
          }
          if (prop === 'delete') {
            return async () => Promise.reject(deleteBoom)
          }
          const value = Reflect.get(target, prop)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as unknown as Payload

      const { handleSignup } = await import('@/app/api/auth/signup/handler')
      const res = await handleSignup(
        jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }),
        failing,
      )
      expect(res.status).toBe(503)
      // The compensating delete's own failure was logged for operators…
      const logged = errorSpy.mock.calls.some((c) =>
        String(c[0]).includes('compensating user-delete FAILED'),
      )
      expect(logged).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('sealEmailBody roundtrip: distinct ciphertexts, tamper detection', async () => {
    const plaintext = '/api/auth/confirm?token=abc123XYZ_-456'
    const a = sealEmailBody(plaintext)
    const b = sealEmailBody(plaintext)
    expect(a).not.toBe(b) // fresh IV every time
    expect(openEmailBody(a)).toBe(plaintext)
    expect(openEmailBody(b)).toBe(plaintext)

    const tampered = a.slice(0, -4) + (a.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    expect(() => openEmailBody(tampered)).toThrow()
  })
})
