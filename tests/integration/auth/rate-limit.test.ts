import { beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { accountComponent, createMongoRateLimiter, enforceRateLimit } from '@/auth/rate-limit'
import { handleLogin } from '@/app/api/auth/login/handler'
import { handleJoin } from '@/app/api/join/handler'
import type { Payload } from 'payload'

/**
 * ECLASS-59 — shared-storage rate limiting.
 *
 *   - sliding window: boundary, retryAfter, unlock after the window passes
 *     (injected clock);
 *   - MULTI-INSTANCE: two independent limiter objects over the same Mongo see
 *     ONE window (the old per-process Map could not);
 *   - CONCURRENCY: parallel hits cannot exceed the cap (atomic $push);
 *   - PRIVACY: no raw login/email is ever stored in the rate collection;
 *   - ROUTE: login answers 429 + Retry-After, identical for known and unknown
 *     emails (no enumeration), another source IP is not affected;
 *   - FAIL-CLOSED: a limiter infrastructure failure rejects the auth mutation
 *     as 503 instead of passing unmetered.
 */

const jsonReq = (url: string, body: unknown, ip?: string): NextRequest => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (ip) headers['x-forwarded-for'] = ip
  return new NextRequest(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

integrationSuite('ECLASS-59: shared rate limiting (Mongo sliding window)', () => {
  beforeEach(async () => {
    await clearData()
    const p = await getPayloadSingleton()
    await p.db.connection.collection('rate-limits').deleteMany({})
  })

  it('window boundary, retryAfter and unlock after the window passes', async () => {
    const p = await getPayloadSingleton()
    let now = 1_000_000
    const clock = { now: () => now }
    const limiter = createMongoRateLimiter({
      payload: p,
      clock,
      windowMs: 1_000,
      max: 3,
      collection: 'rate-limits-test-window',
    })

    for (let i = 0; i < 3; i++) {
      expect((await limiter.hit('k')).allowed).toBe(true)
    }
    const denied = await limiter.hit('k')
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterMs).toBeGreaterThan(0)
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1_000)

    // The same instant a DIFFERENT key is unaffected.
    expect((await limiter.hit('other')).allowed).toBe(true)

    // Unlock: after the whole window passes, the key is clean again.
    now += 1_001
    expect((await limiter.hit('k')).allowed).toBe(true)

    await p.db.connection.collection('rate-limits-test-window').drop().catch(() => undefined)
  })

  it('two limiter instances share ONE window (multi-instance)', async () => {
    const p = await getPayloadSingleton()
    const clock = { now: () => Date.now() }
    const a = createMongoRateLimiter({ payload: p, clock, windowMs: 60_000, max: 3, collection: 'rate-limits-test-multi' })
    const b = createMongoRateLimiter({ payload: p, clock, windowMs: 60_000, max: 3, collection: 'rate-limits-test-multi' })

    expect((await a.hit('shared')).allowed).toBe(true)
    expect((await a.hit('shared')).allowed).toBe(true)
    expect((await b.hit('shared')).allowed).toBe(true)
    // The 4th hit — through the OTHER instance — is denied: state is shared.
    expect((await b.hit('shared')).allowed).toBe(false)

    await p.db.connection.collection('rate-limits-test-multi').drop().catch(() => undefined)
  })

  it('parallel hits cannot exceed the cap (atomic $push)', async () => {
    const p = await getPayloadSingleton()
    const clock = { now: () => Date.now() }
    const limiter = createMongoRateLimiter({ payload: p, clock, windowMs: 60_000, max: 5, collection: 'rate-limits-test-race' })

    const results = await Promise.all(Array.from({ length: 12 }, () => limiter.hit('race')))
    const allowed = results.filter((r) => r.allowed).length
    expect(allowed).toBe(5)

    await p.db.connection.collection('rate-limits-test-race').drop().catch(() => undefined)
  })

  it('no raw login or email is persisted in the rate collection', async () => {
    const p = await getPayloadSingleton()
    const secretEmail = uniqueEmail('privacy-probe')
    const headers = new Headers({ 'x-forwarded-for': '10.0.0.1' })
    const limited = await enforceRateLimit({
      payload: p,
      headers,
      bucket: 'login',
      policy: { windowMs: 60_000, max: 5 },
      account: secretEmail,
    })
    expect(limited).toBeNull()

    const coll = p.db.connection.collection('rate-limits')
    const docs = await coll.find({}).toArray()
    const serialized = JSON.stringify(docs)
    expect(serialized).not.toContain(secretEmail)
    expect(serialized).not.toContain('eclasstest.ru')
    // The account component IS there — as a sha256 prefix, not the login.
    expect(serialized).toContain(accountComponent(secretEmail))
  })

  it('login route: 429 + Retry-After; per-account and per-source windows behave identically for known/unknown emails', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('limited')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', emailConfirmed: true },
      overrideAccess: true,
    })

    let first429: Response | null = null
    for (let i = 0; i <= 10; i++) {
      const res = await handleLogin(
        jsonReq('http://localhost/api/auth/login', { email, password: 'wrongpass123' }, '203.0.113.9'),
        p,
      )
      if (res.status === 429) {
        first429 = res
        break
      }
    }
    expect(first429, 'the 11th attempt on one account from one source must be limited').not.toBeNull()
    expect(first429!.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(await first429!.json()).toEqual({ ok: false, code: 'rate_limited' })

    // A different email from the same source gets its OWN fresh window — this
    // is identical for existing and non-existing accounts (no enumeration):
    // the limiter never branches on account existence.
    const unknownSameIp = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email: uniqueEmail('ghost'), password: 'wrongpass123' }, '203.0.113.9'),
      p,
    )
    expect(unknownSameIp.status).toBe(401)

    // Email-rotating brute force from ONE source eventually hits the shared
    // source-only window — regardless of which emails are used.
    let sawSource429 = false
    for (let i = 0; i < 105; i++) {
      const res = await handleLogin(
        jsonReq('http://localhost/api/auth/login', { email: uniqueEmail(`rot${i}`), password: 'wrongpass123' }, '203.0.113.77'),
        p,
      )
      if (res.status === 429) {
        sawSource429 = true
        break
      }
    }
    expect(sawSource429, '100+ attempts from one source must trip the source window').toBe(true)

    // A clean different source still gets a fresh window.
    const otherSource = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email, password: 'wrongpass123' }, '198.51.100.7'),
      p,
    )
    expect(otherSource.status).toBe(401)
  })

  it('ECLASS-59 hardening: guessing a SPECIFIC invite code is capped per-code even with rotating IPs and logins', async () => {
    const p = await getPayloadSingleton()
    await p.db.connection.collection('rate-limits').deleteMany({ _id: /^join-code\|/ })

    const code = 'GUESS12X'
    let saw429 = false
    for (let i = 0; i < 12; i++) {
      // Rotate EVERYTHING the other buckets key on: fresh IP, fresh login.
      const res = await handleJoin(
        jsonReq('http://localhost/api/join', {
          code,
          login: uniqueEmail(`guess${i}`),
          displayName: 'Угадывающий',
          password: 'longpass123',
        }, `203.0.113.${i % 250 + 1}`),
        p,
      )
      if (res.status === 429) {
        saw429 = true
        expect(res.headers.get('retry-after')).toMatch(/^\d+$/)
        break
      }
    }
    expect(saw429, 'a per-code bucket must cap brute-forcing the 8-char code regardless of IP/login rotation').toBe(true)
  })

  it('performance: parallel logins do not block the event loop (async crypto, async limiter)', async () => {
    const p = await getPayloadSingleton()
    // Confirmed users so every login runs the full verify path.
    const users = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        p.create({
          collection: 'users',
          data: { email: uniqueEmail(`perf${i}`), password: 'longpass123', emailConfirmed: true },
          overrideAccess: true,
        }),
      ),
    )

    const logins = Promise.all(
      users.map((u) =>
        handleLogin(
          jsonReq('http://localhost/api/auth/login', { email: (u as unknown as { email: string }).email, password: 'longpass123' }, `10.9.9.${users.indexOf(u) + 1}`),
          p,
        ),
      ),
    )

    // While the 8 logins are in flight, three chained 25ms timers must fire
    // roughly on time. With the OLD synchronous scrypt on the login path the
    // loop stalled for the whole verify wall-time; with async crypto+limiter
    // the chain completes within a small multiple of its nominal 75ms.
    const t0 = Date.now()
    const tick = () => new Promise<void>((r) => setTimeout(r, 25))
    await tick(); await tick(); await tick()
    const timerMs = Date.now() - t0

    const results = await logins
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(timerMs, `3×25ms timer chain took ${timerMs}ms while 8 logins ran — event loop blocked?`).toBeLessThan(400)
  })

  it('fail-closed: a limiter infrastructure failure rejects the mutation with 503', async () => {
    const p = await getPayloadSingleton()
    const boom = new Error('rate store down')
    const failing = new Proxy(p as unknown as Record<string | symbol, unknown>, {
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
                  if (name !== 'rate-limits') return orig(name)
                  return new Proxy(orig(name) as object, {
                    get(collTarget, collProp) {
                      if (collProp === 'findOneAndUpdate') return async () => Promise.reject(boom)
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

    const res = await handleLogin(
      jsonReq('http://localhost/api/auth/login', { email: uniqueEmail('fc'), password: 'longpass123' }),
      failing,
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, code: 'error' })
  })
})
