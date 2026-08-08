import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { Payload } from 'payload'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { createEmailConfirm } from '@/auth/email-confirm'
import { handleLogin } from '@/app/api/auth/login/handler'
import { POST as confirmRoute } from '@/app/api/auth/confirm/route'
import { POST as signupRoute } from '@/app/api/auth/signup/route'
import {
  getEmailTransport,
  loggingTransport,
  setEmailTransport,
  type EmailMessage,
  type EmailTransport,
} from '@/email/transport'

/**
 * ECLASS-67 — real email-token confirm flow.
 *
 * Proves against real Mongo+Payload:
 *   - signup issues a one-time token delivered ONLY via the email transport
 *     (never the response body, never the logs)
 *   - confirm consumes the token atomically: hash + !confirmed + !expired
 *   - single-use: a replay matches zero docs
 *   - concurrency: two parallel confirms of the same token → exactly one wins
 *   - anti-enumeration: wrong / expired / replay all collapse to the same
 *     `{ ok: false, code: 'invalid_or_expired' }` response
 *   - infrastructure errors surface as 503, not masked as invalid
 */

const HOUR = 60 * 60 * 1000
const TTL = 24 * HOUR

/** Test-only transport: records sent messages and exposes the raw token. */
class InMemoryOutbox implements EmailTransport {
  readonly sent: EmailMessage[] = []
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg)
  }
  /** Raw token from the most recent message addressed to `to`, or undefined. */
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

function jsonReq(url: string, body: unknown): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

integrationSuite('ECLASS-67: email-token confirm flow', () => {
  let outbox: InMemoryOutbox

  beforeEach(async () => {
    await clearData()
    outbox = new InMemoryOutbox()
    setEmailTransport(outbox)
  })

  afterEach(() => {
    setEmailTransport(loggingTransport) // restore hygiene between suites
  })

  it('signup → confirm → login passes end-to-end; token comes from the outbox, not the response', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('flow')
    const password = 'longpass123'

    const signupRes = await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password }))
    expect(signupRes.status).toBe(200)
    const signupBody = await signupRes.json()
    const userId = signupBody.userId as string

    // The raw token is ONLY in the outbox — never in the response body.
    const serializedSignup = JSON.stringify(signupBody)
    expect(serializedSignup).not.toMatch(/token|confirmation/i)
    const token = outbox.tokenFor(email)
    expect(token, 'outbox must have captured the confirmation token').toBeTypeOf('string')

    // confirm consumes the token.
    const confirmRes = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token }))
    expect(confirmRes.status).toBe(200)
    expect(await confirmRes.json()).toEqual({ ok: true })

    // The hash was cleared in the DB (single-use).
    const user = await p.findByID({ collection: 'users', id: userId, overrideAccess: true })
    expect(user.emailConfirmed).toBe(true)
    expect(user.emailConfirmationTokenHash).toBeFalsy()

    // login now succeeds with a proper cookie.
    const loginRes = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email, password }),
      p,
    )
    expect(loginRes.status).toBe(200)
    expect(loginRes.headers.get('set-cookie')).toMatch(/eclass_session=/)
  })

  it('a wrong token is refused and leaves emailConfirmed=false', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('wrong')
    const signupRes = await signupRoute(
      jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }),
    )
    const userId = (await signupRes.json()).userId as string

    const res = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token: 'totally-bogus-token' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, code: 'invalid_or_expired' })

    const user = await p.findByID({ collection: 'users', id: userId, overrideAccess: true })
    expect(user.emailConfirmed).toBe(false)
  })

  it('an expired token is refused', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('exp')
    const signupRes = await signupRoute(
      jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }),
    )
    const userId = (await signupRes.json()).userId as string
    const token = outbox.tokenFor(email)!
    expect(token).toBeTypeOf('string')

    // Force the stored expiry into the past via a trusted server update. The
    // server-only fields (access.update: () => false) require overrideAccess.
    const clock = { now: () => Date.now() }
    const pastExpiry = clock.now() - HOUR
    await p.update({
      collection: 'users',
      id: userId,
      data: { emailConfirmationTokenExpiresAt: pastExpiry },
      overrideAccess: true,
    })

    const res = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, code: 'invalid_or_expired' })
  })

  it('a replayed token is refused after a successful confirm (single-use)', async () => {
    const email = uniqueEmail('replay')
    await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))
    const token = outbox.tokenFor(email)!

    const first = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token }))
    expect(first.status).toBe(200)

    const second = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token }))
    expect(second.status).toBe(400)
    expect(await second.json()).toEqual({ ok: false, code: 'invalid_or_expired' })
  })

  it('two concurrent confirms of the same token: exactly one wins, the other is refused', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('concurrent')
    const signupRes = await signupRoute(
      jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }),
    )
    const userId = (await signupRes.json()).userId as string
    const token = outbox.tokenFor(email)!

    // Race two confirm route calls on the same token. The atomic update-by-where
    // must serialise: exactly one flips emailConfirmed (clearing the hash), the
    // other matches zero docs.
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

  it('anti-enumeration: wrong / expired / replay / unknown all return the identical body+status', async () => {
    const email = uniqueEmail('enum')
    await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))
    const token = outbox.tokenFor(email)!

    // 1) unknown token
    const unknown = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token: 'no-such-token' }))
    // 2) valid token consumed once
    const ok = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token }))
    // 3) replay of the now-consumed token
    const replay = await confirmRoute(jsonReq('http://localhost/api/auth/confirm', { token }))

    expect(ok.status).toBe(200)
    for (const res of [unknown, replay]) {
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, code: 'invalid_or_expired' })
    }
    // All failure bodies are byte-identical — no timing/status side-channel.
    const bodies = await Promise.all([unknown.json(), replay.json()])
    expect(bodies[0]).toEqual(bodies[1])
  })

  it('the raw token is never persisted — only its SHA-256 hash', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('hash')
    const signupRes = await signupRoute(
      jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }),
    )
    const userId = (await signupRes.json()).userId as string
    const rawToken = outbox.tokenFor(email)!
    expect(rawToken).toBeTypeOf('string')

    const user = await p.findByID({ collection: 'users', id: userId, overrideAccess: true })
    // The stored value is a 64-char hex sha256, NOT the raw base64url token.
    expect(user.emailConfirmationTokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(user.emailConfirmationTokenHash).not.toBe(rawToken)
    expect(JSON.stringify(user)).not.toContain(rawToken)
  })

  it('a DB error during confirm is surfaced as 503, NOT masked as invalid', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('boom')
    await signupRoute(jsonReq('http://localhost/api/auth/signup', { email, password: 'longpass123' }))
    const token = outbox.tokenFor(email)!

    // Wrap the payload so update() rejects with a 503 — the confirm handler
    // must propagate it as 503, not collapse it to 400 invalid_or_expired.
    const boom: Error & { status?: number } = Object.assign(new Error('connection refused'), {
      status: 503,
    })
    const throwingPayload = new Proxy(p as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop === 'update') return async () => Promise.reject(boom)
        const value = target[prop as symbol]
        return typeof value === 'function' ? value.bind(p) : value
      },
    }) as unknown as Payload

    const confirm = createEmailConfirm({
      payload: throwingPayload,
      transport: outbox,
      clock: { now: () => Date.now() },
      ttlMs: TTL,
    })
    await expect(confirm.confirm(token)).rejects.toThrow(/connection refused/)
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
      // Metadata is present, but the body / token never appears.
      expect(logged).toContain('someone@example.com')
      expect(logged).toContain('body suppressed')
      expect(logged).not.toContain('SECRET-BEARER-VALUE')
    } finally {
      logSpy.mockRestore()
    }
  })
})
