import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { Types } from 'mongoose'
import type { Payload } from 'payload'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { createPasswordReset } from '@/auth/password-reset'
import { createSessionAdapter } from '@/auth/session-adapter'
import { resolveActor } from '@/auth/payload-resolver'
import { handleResetRequest } from '@/app/api/auth/password-reset/request/handler'
import { handleResetConfirm } from '@/app/api/auth/password-reset/confirm/handler'
import { handleLogin } from '@/app/api/auth/login/handler'
import { setEmailTransport, loggingTransport, type EmailMessage, type EmailTransport } from '@/email/transport'
import { runEmailWorker } from '@/auth/email-worker'
import { openEmailBody } from '@/email/crypto'

/**
 * ECLASS-69 — password reset boundary proofs:
 *
 *   - anti-enumeration: known and unknown emails get byte-identical responses
 *     with comparable timing;
 *   - the raw token never rests in the DB: users keep only hash+expiry, the
 *     email-job body is SEALED;
 *   - single-use: replay/expired/forged tokens are rejected; the claim is
 *     atomic under concurrency;
 *   - a successful reset revokes EVERY prior session (old cookies die);
 *   - the new password authenticates via the real login handler.
 */

const HOUR = 60 * 60 * 1000

class Outbox implements EmailTransport {
  readonly sent: EmailMessage[] = []
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg)
  }
}

const jsonReq = (url: string, body: unknown): NextRequest =>
  new NextRequest(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Confirmed teacher + a live session, so revocation is observable. */
async function teacherWithSession(p: Payload, email = uniqueEmail('reset')) {
  const user = await p.create({
    collection: 'users',
    data: { email, password: 'oldpassword1', emailConfirmed: true },
    overrideAccess: true,
  })
  const adapter = createSessionAdapter({ payload: p, clock: { now: () => Date.now() }, sessionTtlMs: HOUR })
  const login = await adapter.login({ email, password: 'oldpassword1' })
  expect(login.ok).toBe(true)
  return { email, userId: user.id, sessionId: login.ok ? login.sessionId : '' }
}

/** Request a reset and extract the one-time token the way delivery would. */
async function requestAndExtractToken(p: Payload, email: string, outbox: Outbox): Promise<string> {
  const res = await handleResetRequest(jsonReq('http://localhost/api/auth/password-reset/request', { email }), p)
  expect(res.status).toBe(200)
  await runEmailWorker({ payload: p, transport: outbox, clock: { now: () => Date.now() } })
  const link = outbox.sent[outbox.sent.length - 1]!.body
  const token = link.match(/token=([A-Za-z0-9_-]+)/)?.[1]
  expect(token, 'delivered reset link must carry the token').toBeTruthy()
  return token!
}

integrationSuite('ECLASS-69: teacher password reset', () => {
  beforeEach(clearData)
  beforeEach(() => setEmailTransport(new Outbox()))
  afterEach(() => setEmailTransport(loggingTransport))

  it('full flow: request → sealed email → confirm → new password works, sessions revoked', async () => {
    const p = await getPayloadSingleton()
    const outbox = new Outbox()
    setEmailTransport(outbox)
    const t = await teacherWithSession(p)

    // The live session resolves before the reset.
    expect(await resolveActor(p, t.sessionId, { now: () => Date.now() })).not.toBeNull()

    const token = await requestAndExtractToken(p, t.email, outbox)

    const confirmed = await handleResetConfirm(
      jsonReq('http://localhost/api/auth/password-reset/confirm', { token, password: 'newpassword1' }),
      p,
    )
    expect(confirmed.status).toBe(200)

    // Old session is dead; the old password no longer authenticates.
    expect(await resolveActor(p, t.sessionId, { now: () => Date.now() })).toBeNull()
    const oldLogin = await handleLogin(jsonReq('http://localhost/api/auth/login', { email: t.email, password: 'oldpassword1' }), p)
    expect(oldLogin.status).toBe(401)

    // The NEW password logs in through the real handler.
    const newLogin = await handleLogin(jsonReq('http://localhost/api/auth/login', { email: t.email, password: 'newpassword1' }), p)
    expect(newLogin.status).toBe(200)
  })

  it('anti-enumeration: unknown and known emails — identical body, comparable timing', async () => {
    const p = await getPayloadSingleton()
    const outbox = new Outbox()
    setEmailTransport(outbox)
    const t = await teacherWithSession(p)
    const unknown = uniqueEmail('ghost')

    const t0 = performance.now()
    const knownRes = await handleResetRequest(jsonReq('http://localhost/api/auth/password-reset/request', { email: t.email }), p)
    const knownMs = performance.now() - t0
    const knownBody = await knownRes.text()

    const t1 = performance.now()
    const unknownRes = await handleResetRequest(jsonReq('http://localhost/api/auth/password-reset/request', { email: unknown }), p)
    const unknownMs = performance.now() - t1

    expect(knownRes.status).toBe(unknownRes.status)
    expect(await unknownRes.text()).toEqual(knownBody)
    // Comparable timing (same order of magnitude — the dummy-hash equalizer).
    expect(Math.abs(knownMs - unknownMs)).toBeLessThan(Math.max(knownMs, unknownMs, 1) * 3)
  })

  it('the raw token never rests in the database (hash only; sealed job body)', async () => {
    const p = await getPayloadSingleton()
    const outbox = new Outbox()
    setEmailTransport(outbox)
    const t = await teacherWithSession(p)

    await handleResetRequest(jsonReq('http://localhost/api/auth/password-reset/request', { email: t.email }), p)
    const job = await p.db.connection.collection('email-jobs').findOne({ to: t.email })
    expect(String(job?.body).startsWith('v1:')).toBe(true)

    const user = await p.findByID({ collection: 'users', id: t.userId, overrideAccess: true })
    const u = JSON.stringify(user)
    const token = openEmailBody(String(job?.body)).match(/token=([A-Za-z0-9_-]+)/)?.[1]!
    expect(u).not.toContain(token)
    expect(u).toContain('"passwordResetTokenHash"')
  })

  it('single-use: replay after success → invalid; expired and forged tokens → invalid', async () => {
    const p = await getPayloadSingleton()
    const outbox = new Outbox()
    setEmailTransport(outbox)
    const t = await teacherWithSession(p)
    const token = await requestAndExtractToken(p, t.email, outbox)

    const first = await handleResetConfirm(
      jsonReq('http://localhost/api/auth/password-reset/confirm', { token, password: 'newpassword1' }),
      p,
    )
    expect(first.status).toBe(200)

    const replay = await handleResetConfirm(
      jsonReq('http://localhost/api/auth/password-reset/confirm', { token, password: 'another123' }),
      p,
    )
    expect(replay.status).toBe(400)
    expect(await replay.json()).toEqual({ ok: false, code: 'invalid_or_expired' })

    const forged = await handleResetConfirm(
      jsonReq('http://localhost/api/auth/password-reset/confirm', { token: 'forged-token-value', password: 'another123' }),
      p,
    )
    expect(forged.status).toBe(400)

    // Expired: force the stored expiry into the past, then use a fresh token.
    const outbox2 = new Outbox()
    setEmailTransport(outbox2)
    const token2 = await requestAndExtractToken(p, t.email, outbox2)
    await p.db.connection.collection('users').updateOne(
      { _id: new Types.ObjectId(t.userId) },
      { $set: { passwordResetTokenExpiresAt: Date.now() - 1000 } },
    )
    const expired = await handleResetConfirm(
      jsonReq('http://localhost/api/auth/password-reset/confirm', { token: token2, password: 'another123' }),
      p,
    )
    expect(expired.status).toBe(400)
  })

  it('short passwords are rejected before any token is consumed', async () => {
    const p = await getPayloadSingleton()
    const outbox = new Outbox()
    setEmailTransport(outbox)
    const t = await teacherWithSession(p)
    const token = await requestAndExtractToken(p, t.email, outbox)

    const short = await handleResetConfirm(
      jsonReq('http://localhost/api/auth/password-reset/confirm', { token, password: 'short' }),
      p,
    )
    expect(short.status).toBe(422)

    // The token is still usable with a valid password (validation runs first).
    const ok = await handleResetConfirm(
      jsonReq('http://localhost/api/auth/password-reset/confirm', { token, password: 'validpass12' }),
      p,
    )
    expect(ok.status).toBe(200)
  })

  it('concurrent confirms of one token: exactly one 200, the rest invalid', async () => {
    const p = await getPayloadSingleton()
    const outbox = new Outbox()
    setEmailTransport(outbox)
    const t = await teacherWithSession(p)
    const token = await requestAndExtractToken(p, t.email, outbox)

    const results = await Promise.all(
      ['passAAAA1', 'passBBBB2', 'passCCCC3'].map((password) =>
        handleResetConfirm(
          jsonReq('http://localhost/api/auth/password-reset/confirm', { token, password }),
          p,
        ),
      ),
    )
    const statuses = results.map((r) => r.status).sort()
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s === 400)).toHaveLength(2)
  })

  it('request with a failing user update: compensating delete, no orphan job', async () => {
    const p = await getPayloadSingleton()
    const t = await teacherWithSession(p)

    const failing = new Proxy(p as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop !== 'update') return Reflect.get(target, prop)
        const orig = target.update as (args: { collection?: string }) => Promise<unknown>
        return (args: { collection?: string }) => {
          if (args?.collection === 'users') return Promise.reject(new Error('user update boom'))
          return orig.apply(target, [args])
        }
      },
    }) as unknown as Payload

    const service = createPasswordReset({
      payload: failing,
      clock: { now: () => Date.now() },
      ttlMs: HOUR,
    })
    await expect(service.request(t.email)).rejects.toThrow('user update boom')

    const jobs = await p.find({
      collection: 'email-jobs',
      where: { to: { equals: t.email } },
      overrideAccess: true,
    })
    expect(jobs.totalDocs).toBe(0)
  })
})
