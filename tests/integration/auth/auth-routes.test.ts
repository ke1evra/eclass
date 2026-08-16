import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import type { Payload } from 'payload'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { handleLogin } from '@/app/api/auth/login/handler'
import { POST as signup } from '@/app/api/auth/signup/route'
import { POST as logout } from '@/app/api/auth/logout/route'
import { POST as confirm } from '@/app/api/auth/confirm/route'
import {
  loggingTransport,
  setEmailTransport,
  type EmailMessage,
  type EmailTransport,
} from '@/email/transport'
import { runEmailWorker } from '@/auth/email-worker'
import { SESSION_TTL_MS } from '@/auth/session-ttl'

/**
 * ECLASS-65 — route-boundary integration test (audit block 1 + 3, and the five
 * "real route test" requirements).
 *
 * The prior coverage proved invariants at the adapter/resolver layer but never
 * through a real route handler: this file calls the actual handler code with
 * real NextRequest / NextResponse objects and inspects the HTTP surface
 * (Set-Cookie header + body) — exactly what a client sees.
 *
 * In-process handler invocation (no HTTP server): the handlers are pure
 * functions of (NextRequest, payload); we call them directly, which exercises
 * the real cookie-setting and body-shaping code paths.
 */

const HOUR = 60 * 60 * 1000

/** Build a POST NextRequest with a JSON body and optional Cookie header. */
function jsonReq(url: string, body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  return new NextRequest(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/** Parse the opaque session id out of a Set-Cookie header value. */
function sessionIdFromCookie(setCookie: string | null): string {
  expect(setCookie).not.toBeNull()
  // "eclass_session=<value>; Path=/; HttpOnly; ..."
  const match = setCookie!.match(/eclass_session=([^;]+)/)
  expect(match, 'Set-Cookie must contain eclass_session=<opaque>').not.toBeNull()
  const value = match?.[1]
  expect(value, 'captured cookie value must be present').toBeTypeOf('string')
  return value as string
}

/** Read the one session row for a user (assumes exactly one). */
async function sessionRowFor(p: Payload, userId: string | number) {
  const { docs } = await p.find({
    collection: 'sessions',
    where: { userId: { equals: String(userId) } },
    overrideAccess: true,
  })
  return docs[0] as { sessionId: string; revoked: boolean; role: string } | undefined
}

/**
 * Test-only email transport. The signup handler delivers the confirmation
 * token here (never to the response body); the test reads it programmatically
 * to drive the confirm step. Mirrors the outbox in email-confirm.test.ts.
 */
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
}

integrationSuite('ECLASS-65: auth route boundary (handlers end-to-end)', () => {
  const outbox = new InMemoryOutbox()

  beforeEach(async () => {
    await clearData()
    outbox.sent.length = 0
    setEmailTransport(outbox)
  })

  afterEach(() => {
    setEmailTransport(loggingTransport) // restore hygiene between suites
  })

  it('login response body contains NO sessionId / JWT / password / hash', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('leak')
    const password = 'longpass123'
    await p.create({
      collection: 'users',
      data: { email, password, role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })

    const res = await handleLogin(jsonReq('http://localhost/api/auth/login', { email, password }), p)
    expect(res.status).toBe(200)
    const body = await res.json()
    const serialized = JSON.stringify(body)

    // Body shape is exactly { ok, userId }.
    expect(body).toEqual({ ok: true, userId: body.userId })
    expect(typeof body.userId).toBe('string')

    // No secret material leaks into the body.
    expect(serialized).not.toContain('sessionId')
    expect(serialized).not.toContain(password)
    expect(serialized).not.toMatch(/hash|salt|scrypt|bcrypt/i)
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]/) // JWT pattern
    expect(serialized).not.toMatch(/"token"/i)
  })

  it('Set-Cookie carries an opaque token + HttpOnly/Secure/SameSite/Path/Max-Age', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('cookie')
    const password = 'longpass123'
    const user = await p.create({
      collection: 'users',
      data: { email, password, role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })

    const res = await handleLogin(jsonReq('http://localhost/api/auth/login', { email, password }), p)
    expect(res.status).toBe(200)

    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).not.toBeNull()
    const sc = setCookie!
    expect(sc).toMatch(/HttpOnly/i)
    expect(sc).toMatch(/Secure/i)
    expect(sc).toMatch(/SameSite=Lax/i)
    expect(sc).toMatch(/Path=\/(;|$)/i)
    expect(sc).toMatch(new RegExp(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`, 'i'))

    const token = sessionIdFromCookie(sc)
    // The opaque cookie value must NOT be the userId, the password, or a JWT.
    expect(token).not.toBe(user.id)
    expect(token).not.toContain(password)
    expect(token).not.toMatch(/eyJ[A-Za-z0-9_-]/)
    // And it must resolve to the user through the session row in the DB.
    const row = await sessionRowFor(p, user.id)
    expect(row?.sessionId).toBe(token)
  })

  it('logout revokes ONLY the cookie session; body-supplied sessionId/userId are ignored', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('logout')
    const password = 'longpass123'
    const user = await p.create({
      collection: 'users',
      data: { email, password, role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })

    // Establish a real session via the login handler.
    const loginRes = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email, password }),
      p,
    )
    const realToken = sessionIdFromCookie(loginRes.headers.get('set-cookie'))
    let row = await sessionRowFor(p, user.id)
    expect(row?.revoked).toBe(false)

    // Logout reads ONLY the cookie. The body tries to supply a forged
    // sessionId/userId — they must be ignored.
    const logoutRes = await logout(
      jsonReq(
        'http://localhost/api/auth/logout',
        { sessionId: 'forged-from-body', userId: 'also-forged' },
        `eclass_session=${realToken}`,
      ),
    )
    expect(logoutRes.status).toBe(200)
    expect(await logoutRes.json()).toEqual({ ok: true })

    // The cookie session was revoked.
    row = await sessionRowFor(p, user.id)
    expect(row?.revoked).toBe(true)

    // The response always clears the cookie: empty value + Max-Age=0. Next.js
    // serializes attributes as `eclass_session=; Path=/; Max-Age=0; Secure;
    // HttpOnly; SameSite=lax` — Path=/ sits between the empty value and
    // Max-Age, so check each attribute independently rather than as a run.
    const cleared = logoutRes.headers.get('set-cookie')!
    expect(cleared).toMatch(/eclass_session=;/i)
    expect(cleared).toMatch(/Max-Age=0/i)
  })

  it('logout without a cookie is a no-op even if the body carries a real sessionId', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('noop')
    const password = 'longpass123'
    const user = await p.create({
      collection: 'users',
      data: { email, password, role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })
    const loginRes = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email, password }),
      p,
    )
    const realToken = sessionIdFromCookie(loginRes.headers.get('set-cookie'))

    // No Cookie header at all. The body carries the REAL sessionId — it must
    // still be ignored; logout without a cookie must not touch any session.
    const res = await logout(jsonReq('http://localhost/api/auth/logout', { sessionId: realToken }))
    expect(res.status).toBe(200)
    const row = await sessionRowFor(p, user.id)
    expect(row?.revoked).toBe(false)
  })

  it('signup → confirm → login is passable through handlers', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('flow')
    const password = 'longpass123'

    // 1) signup — handler creates a teacher with emailConfirmed=false and
    //    issues a one-time token delivered via the email transport (outbox).
    const signupRes = await signup(jsonReq('http://localhost/api/auth/signup', { email, password }))
    expect(signupRes.status).toBe(200)
    const signupBody = await signupRes.json()
    expect(signupBody).toEqual({ ok: true, userId: signupBody.userId })
    const userId = signupBody.userId as string
    // The token is NEVER in the response body.
    expect(JSON.stringify(signupBody)).not.toMatch(/token|confirmation/i)

    // 2) login BEFORE confirm — must be refused with email_not_confirmed (403).
    const earlyLogin = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email, password }),
      p,
    )
    expect(earlyLogin.status).toBe(403)
    expect(await earlyLogin.json()).toEqual({ ok: false, code: 'email_not_confirmed' })

    // 3) confirm — the worker drains the outbox and delivers the token; the
    //    signup response never contained it.
    await runEmailWorker({ payload: p, transport: outbox, clock: { now: () => Date.now() } })
    const token = outbox.tokenFor(email)
    expect(token, 'outbox must have captured the confirmation token').toBeTypeOf('string')
    const confirmRes = await confirm(jsonReq('http://localhost/api/auth/confirm', { token }))
    expect(confirmRes.status).toBe(200)
    expect(await confirmRes.json()).toEqual({ ok: true })

    // 4) login AFTER confirm — succeeds with a properly flagged cookie.
    const loginRes = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email, password }),
      p,
    )
    expect(loginRes.status).toBe(200)
    const setCookie = loginRes.headers.get('set-cookie')!
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    // userId in the body matches the signed-up user.
    expect((await loginRes.json()).userId).toBe(userId)
  })

  it('a DB error during login becomes 5xx, NOT 401 invalid_credentials', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('boom')
    const password = 'longpass123'
    await p.create({
      collection: 'users',
      data: { email, password, role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })

    // Wrap the real payload in a Proxy that makes `login` reject with a 503,
    // simulating a Mongo outage on the auth path. All other methods delegate
    // to the real instance. (Pattern from payload-auth-authority.test.ts.)
    const boom: Error & { status?: number } = Object.assign(new Error('connection refused'), {
      status: 503,
    })
    const throwingPayload = new Proxy(p as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop === 'login') return async () => Promise.reject(boom)
        const value = target[prop as symbol]
        return typeof value === 'function' ? value.bind(p) : value
      },
    }) as unknown as Payload

    const res = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email, password }),
      throwingPayload,
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, code: 'error' })
  })

  it('counter-check: a genuine wrong password still yields 401 invalid_credentials', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('wrong')
    const password = 'longpass123'
    await p.create({
      collection: 'users',
      data: { email, password, role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })

    const res = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email, password: 'totally-wrong-456' }),
      p,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, code: 'invalid_credentials' })
  })
})
