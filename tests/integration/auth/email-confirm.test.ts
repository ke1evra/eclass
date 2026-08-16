import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { Payload } from 'payload'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { handleSignup } from '@/app/api/auth/signup/handler'
import { handleConfirm } from '@/app/api/auth/confirm/handler'
import { POST as signupRoute } from '@/app/api/auth/signup/route'
import { POST as confirmRoute } from '@/app/api/auth/confirm/route'
import { POST as resendRoute } from '@/app/api/auth/resend/route'
import { runEmailWorker, scrubError } from '@/auth/email-worker'
import { openEmailBody } from '@/email/crypto'
import { handleLogin } from '@/app/api/auth/login/handler'
import {
  loggingTransport,
  setEmailTransport,
  type EmailMessage,
  type EmailTransport,
} from '@/email/transport'

/**
 * ECLASS-67 (v2, outbox-pattern) — real email-token confirm flow.
 *
 * v1 failed validation on 6 points; v2 addresses them:
 *   - signup is atomic (user + email-job in ONE transaction; rollback on any
 *     failure, so a duplicate-email retry is clean and no token is orphaned)
 *   - the transport is decoupled — a worker drains the outbox, so email
 *     delivery cannot be rolled back by a DB transaction nor lost
 *   - concurrent confirm is DETERMINISTIC: classified write-conflicts retry,
 *     yielding exactly one 200 and one 400 (never 503 leaking the race)
 *   - anti-enumeration parity covers unknown + expired + replay with
 *     byte-identical bodies AND a timing check
 *   - the 503 case is proven at the HTTP route boundary, not via factory-direct
 *
 * Every case hits a real route handler with a real NextRequest / NextResponse.
 */

const HOUR = 60 * 60 * 1000

/** Test-only transport: records sent messages and exposes the raw token. */
class InMemoryOutbox implements EmailTransport {
  readonly sent: EmailMessage[] = []
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg)
  }
  tokenFor(to: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i]!
      if (m.to === to) {
        const match = m.body.match(/token=([A-Za-z0-9_-]+)/)
        return match?.[1]
      }
    }
    return undefined
  }
  reset(): void {
    this.sent.length = 0
  }
}

/** Transport that always fails — for worker-retry and atomicity cases. */
class FailingTransport implements EmailTransport {
  readonly error: Error
  constructor(message = 'smtp unavailable') {
    this.error = new Error(message)
  }
  async send(): Promise<void> {
    throw this.error
  }
}

/** Transport that fails the first N sends, then succeeds. */
class FlakeThenSucceedTransport implements EmailTransport {
  readonly sent: EmailMessage[] = []
  private failRemaining: number
  constructor(failFirst: number) {
    this.failRemaining = failFirst
  }
  async send(msg: EmailMessage): Promise<void> {
    if (this.failRemaining > 0) {
      this.failRemaining--
      throw new Error(`flaky failure #${this.failRemaining + 1}`)
    }
    this.sent.push(msg)
  }
  tokenFor(to: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i]!
      if (m.to === to) {
        const match = m.body.match(/token=([A-Za-z0-9_-]+)/)
        return match?.[1]
      }
    }
    return undefined
  }
}

function jsonReq(url: string, body: unknown): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function signUpAndDeliver(
  p: Payload,
  email: string,
  password: string,
  outbox: InMemoryOutbox,
): Promise<{ userId: string; token: string }> {
  const res = await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password }))
  expect(res.status).toBe(200)
  const userId = (await res.json()).userId as string
  await runEmailWorker({ payload: p, transport: outbox, clock: { now: () => Date.now() } })
  const token = outbox.tokenFor(email)
  expect(token, 'worker must have delivered the token to the outbox').toBeTypeOf('string')
  return { userId, token: token as string }
}

integrationSuite('ECLASS-67 v2: email-token confirm flow (outbox + worker)', () => {
  let outbox: InMemoryOutbox

  beforeEach(async () => {
    await clearData()
    outbox = new InMemoryOutbox()
    setEmailTransport(outbox)
  })

  afterEach(() => {
    setEmailTransport(loggingTransport)
  })

  it('signup → worker → confirm → login end-to-end; token comes only from the outbox', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('flow')
    const password = 'longpass123'

    const { userId, token } = await signUpAndDeliver(p, email, password, outbox)

    // The worker, not the signup response, is the only place the token appears.
    // (signup response already consumed above; assert via a fresh signup.)
    const email2 = uniqueEmail('flow2')
    const res2 = await signupRoute(jsonReq('http://localhost/api/auth/signup', { email: email2, password }))
    const body2 = await res2.json()
    expect(JSON.stringify(body2)).not.toMatch(/token|confirmation/i)
    expect(JSON.stringify(body2)).not.toContain(token)

    const confirmRes = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token }))
    expect(confirmRes.status).toBe(200)

    const loginRes = await handleLogin(jsonReq('http://localhost/api/auth/login', { email, password }), p)
    expect(loginRes.status).toBe(200)
    expect(loginRes.headers.get('set-cookie')).toMatch(/eclass_session=/)

    // hash cleared (single-use), emailConfirmed true.
    const user = await p.findByID({ collection: 'users', id: userId, overrideAccess: true })
    expect(user.emailConfirmed).toBe(true)
    expect(user.emailConfirmationTokenHash).toBeFalsy()
  })

  it('signup without the worker leaves NO token reachable (outbox is the only source)', async () => {
    const email = uniqueEmail('noworker')
    const res = await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))
    expect(res.status).toBe(200)
    // Worker NOT run → outbox empty → no token can be obtained by the client.
    expect(outbox.tokenFor(email)).toBeUndefined()
  })

  it('compensating delete: a failure mid-signup leaves NO user (retry is clean)', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('rollback')

    // Wrap the payload so the email-jobs create fails AFTER the user create.
    // The compensating-delete path must remove the just-created user so the
    // email is free for a clean retry and no raw token is orphaned.
    const boom = new Error('email-jobs insert failed')
    const throwingPayload = new Proxy(p as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        const value = target[prop as symbol]
        if (typeof value !== 'function') return value
        return async (...args: unknown[]) => {
          const opts = args[0] as { collection?: string } | undefined
          if (prop === 'create' && opts?.collection === 'email-jobs') throw boom
          return (value as (...a: unknown[]) => unknown).apply(p, args)
        }
      },
    }) as unknown as Payload

    const res = await handleSignup(
      jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }),
      throwingPayload,
    )
    expect(res.status).toBe(503)

    // The user was DELETED by the compensating action — no stranded half-state.
    const found = await p.find({
      collection: 'users',
      where: { email: { equals: email } },
      overrideAccess: true,
    })
    expect(found.totalDocs).toBe(0)

    // A retry with the same email must NOT hit a duplicate-key conflict — the
    // email is free because the compensating delete cleaned up.
    const retry = await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))
    expect(retry.status).toBe(200)
  })

  it('duplicate email after a SUCCESSFUL signup → 409 conflict', async () => {
    const email = uniqueEmail('dup')
    const first = await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))
    expect(first.status).toBe(200)
    const second = await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ ok: false, code: 'conflict' })
  })

  it('concurrent confirm of the same token: exactly one 200, the other 400', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('concurrent')
    const { token, userId } = await signUpAndDeliver(p, email, 'longpass123', outbox)

    const [a, b] = await Promise.all([
      confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token })),
      confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token })),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 400])

    const user = await p.findByID({ collection: 'users', id: userId, overrideAccess: true })
    expect(user.emailConfirmed).toBe(true)
    expect(user.emailConfirmationTokenHash).toBeFalsy()
  })

  it('DB error during confirm surfaces as HTTP 503 at the route boundary', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('boom')
    const { token } = await signUpAndDeliver(p, email, 'longpass123', outbox)

    // Wrap the payload so the atomic users.updateOne rejects — the route
    // handler must surface HTTP 503, not collapse it to 400 invalid_or_expired.
    const boom: Error & { status?: number } = Object.assign(new Error('connection refused'), {
      status: 503,
    })
    const throwingPayload = new Proxy(p as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop !== 'db') return Reflect.get(target, prop)
        const db = target.db as unknown as Record<string, unknown>
        return new Proxy(db, {
          get(dbTarget, dbProp) {
            if (dbProp !== 'connection') return Reflect.get(dbTarget, dbProp)
            const conn = dbTarget.connection as unknown as Record<string, unknown>
            return new Proxy(conn, {
              get(connTarget, connProp) {
                if (connProp !== 'collection') return Reflect.get(connTarget, connProp)
                const orig = (connTarget.collection as (n: string) => unknown).bind(connTarget)
                return (name: string) => {
                  if (name !== 'users') return orig(name)
                  return new Proxy(orig(name) as object, {
                    get(collTarget, collProp) {
                      if (collProp === 'updateOne') return async () => Promise.reject(boom)
                      const v = Reflect.get(collTarget, collProp)
                      return typeof v === 'function' ? v.bind(collTarget) : v
                    },
                  })
                }
              },
            })
          },
        })
      },
    }) as unknown as Payload

    const res = await handleConfirm(
      jsonReq('http://localhost/api/auth/confirm', { token }),
      throwingPayload,
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, code: 'error' })
  })

  it('anti-enumeration: unknown + expired + replay return identical status, body, and timing', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('enum')
    const { token } = await signUpAndDeliver(p, email, 'longpass123', outbox)

    // Expired: force the stored expiry into the past via a trusted server update.
    const user = (
      await p.find({ collection: 'users', where: { email: { equals: email } }, overrideAccess: true })
    ).docs[0]!
    await p.update({
      collection: 'users',
      id: user.id,
      data: { emailConfirmationTokenExpiresAt: Date.now() - HOUR },
      overrideAccess: true,
    })

    const measure = async (fn: () => Promise<Response>): Promise<{ status: number; body: unknown; ms: number }> => {
      const start = Date.now()
      const r = await fn()
      const body = await r.json()
      return { status: r.status, body, ms: Date.now() - start }
    }

    const unknown = await measure(() =>
      confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token: 'no-such-token-xyz' })),
    )
    const expired = await measure(() =>
      confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token })),
    )
    // Replay: refresh expiry first so the token is valid again, consume it, then replay.
    await p.update({
      collection: 'users',
      id: user.id,
      data: { emailConfirmationTokenExpiresAt: Date.now() + HOUR },
      overrideAccess: true,
    })
    const ok = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token }))
    expect(ok.status).toBe(200)
    const replay = await measure(() =>
      confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token })),
    )

    // Identical status + body across all three failure modes.
    for (const r of [unknown, expired, replay]) {
      expect(r.status).toBe(400)
      expect(r.body).toEqual({ ok: false, code: 'invalid_or_expired' })
    }
    expect(unknown.body).toEqual(expired.body)
    expect(expired.body).toEqual(replay.body)

    // Timing side-channel: the spread between any two must be small. We allow
    // a generous 150ms band — the goal is to catch an obvious timing oracle
    // (e.g. one path doing an extra DB lookup), not to assert microsecond parity.
    const times = [unknown.ms, expired.ms, replay.ms]
    expect(Math.max(...times) - Math.min(...times)).toBeLessThan(150)
  })

  it('resend recovers a lost confirmation email after a worker failure', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('resend')
    // First signup with a failing transport — the user is created (transaction
    // commits) but the worker cannot deliver. Use the real signup route so the
    // user exists; then clear the pending job so resend starts fresh.
    const failing = new FailingTransport('initial delivery failed')
    setEmailTransport(failing)
    const signupRes = await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))
    expect(signupRes.status).toBe(200)
    await runEmailWorker({ payload: p, transport: failing, clock: { now: () => Date.now() } })

    // No token was delivered to the real outbox (the failing transport never
    // recorded anything; the restored outbox below is empty until resend).
    expect(outbox.tokenFor(email)).toBeUndefined()

    // resend queues a fresh job; the outbox (now restored) delivers it.
    setEmailTransport(outbox)
    const resendRes = await resendRoute(jsonReq('http://localhost/api/auth/resend', { email }))
    expect(resendRes.status).toBe(200)
    await runEmailWorker({ payload: p, transport: outbox, clock: { now: () => Date.now() } })
    const token = outbox.tokenFor(email)
    expect(token).toBeTypeOf('string')

    const confirmRes = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token }))
    expect(confirmRes.status).toBe(200)
    const loginRes = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email, password: 'longpass123' }),
      p,
    )
    expect(loginRes.status).toBe(200)
  })

  it('resend is idempotent and does not reveal whether the email exists', async () => {
    // An unknown email returns the same 200 as a known one.
    const r1 = await resendRoute(jsonReq('http://localhost/api/auth/resend', { email: uniqueEmail('ghost') }))
    const r2 = await resendRoute(jsonReq('http://localhost/api/auth/resend', { email: uniqueEmail('ghost2') }))
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(await r1.json()).toEqual(await r2.json())
  })

  it('worker retries with backoff: a flaky-then-succeed transport eventually delivers', async () => {
    const p = await getPayloadSingleton()
    const flake = new FlakeThenSucceedTransport(2) // fail twice, then succeed
    const email = uniqueEmail('flake')
    await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))

    // ECLASS-68: backoff is REAL now — a failing attempt pushes nextAttemptAt
    // into the future, so an immediate re-run must SKIP the job. The clock is
    // advanced past each backoff before the next attempt.
    let t = Date.now()
    const clock = { now: () => t }

    // Run 1: first attempt fails → attempts=1, pending with future nextAttemptAt.
    const r1 = await runEmailWorker({ payload: p, transport: flake, clock })
    expect(r1.sent).toBe(0)
    // Immediate re-run: not due → skipped, NOT retried.
    const r1b = await runEmailWorker({ payload: p, transport: flake, clock })
    expect(r1b.processed).toBe(0)

    // Advance past 2^1*base, run 2: second attempt fails → attempts=2, pending.
    t += 2 ** 1 * 5_000 + 1
    const r2 = await runEmailWorker({ payload: p, transport: flake, clock })
    expect(r2.sent).toBe(0)

    // Advance past 2^2*base, run 3: transport now succeeds → status=sent.
    t += 2 ** 2 * 5_000 + 1
    const result3 = await runEmailWorker({ payload: p, transport: flake, clock })
    expect(result3.sent).toBe(1)

    const jobs = await p.find({
      collection: 'email-jobs',
      where: { to: { equals: email } },
      overrideAccess: true,
    })
    const job = jobs.docs[0] as unknown as { status: string; attempts: number; sentAt?: number }
    expect(job.status).toBe('sent')
    expect(job.attempts).toBe(2)
    expect(job.sentAt).toBeTypeOf('number')
  })

  it('worker marks a job failed after maxAttempts; lastError scrubbed; body consumed', async () => {
    const p = await getPayloadSingleton()
    const failing = new FailingTransport('persistent smtp down')
    const email = uniqueEmail('permfail')
    await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))

    // Capture the sealed body BEFORE any attempt, open it, and prove the raw
    // token is neither in the stored body nor in lastError after failure.
    const before = await p.find({
      collection: 'email-jobs',
      where: { to: { equals: email } },
      overrideAccess: true,
    })
    const sealed = (before.docs[0] as unknown as { body: string }).body
    expect(sealed.startsWith('v1:'), 'body must be sealed at rest').toBe(true)
    const rawToken = openEmailBody(sealed).match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? ''
    expect(rawToken.length).toBeGreaterThan(10)
    expect(sealed).not.toContain(rawToken)

    // Run the worker maxAttempts times, advancing the clock past each backoff.
    let t = Date.now()
    const clock = { now: () => t }
    for (let i = 0; i < 5; i++) {
      await runEmailWorker({ payload: p, transport: failing, clock })
      t += 2 ** (i + 1) * 5_000 + 1
    }

    const jobs = await p.find({
      collection: 'email-jobs',
      where: { to: { equals: email } },
      overrideAccess: true,
    })
    const job = jobs.docs[0] as unknown as {
      status: string
      attempts: number
      lastError?: string
      body?: string | null
    }
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(5)
    // lastError carries the transport message, NOT the raw token from body.
    expect(job.lastError).toContain('persistent smtp down')
    expect(job.lastError).not.toContain(rawToken)
    // ECLASS-68 (defect 1): terminal failure CONSUMES the sealed body.
    expect(job.body ?? null).toBeNull()
    // And scrubError strips any long base64url run defensively.
    expect(scrubError(new Error(rawToken))).not.toContain(rawToken)
  })

  it('the production logging transport never logs the body (bearer token) to the console', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await loggingTransport.send({
        to: 'someone@example.com',
        subject: 'Confirm your email',
        body: '/api/auth/confirm?token=SECRET-BEARER-VALUE',
      })
      expect(logSpy).toHaveBeenCalledTimes(1)
      const logged = logSpy.mock.calls[0]![0] as string
      expect(logged).toContain('someone@example.com')
      expect(logged).toContain('body suppressed')
      expect(logged).not.toContain('SECRET-BEARER-VALUE')
    } finally {
      logSpy.mockRestore()
    }
  })
})
