import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../../integration/_payload'
import type { Payload } from 'payload'
import { createEmailConfirm } from '@/auth/email-confirm'
import { createPasswordReset } from '@/auth/password-reset'
import { runEmailWorker } from '@/auth/email-worker'
import { createAuthService, type AuthStore, type Clock } from '@/auth/service'
import { setEmailTransport, loggingTransport } from '@/email/transport'

/**
 * Branch-coverage hardening (review step 7): the uncovered paths are real
 * behaviours, not noise — resend/job-failure logging, retry exhaustion,
 * consumed-body guard, legacy scrypt verification, rate-window unlock.
 */
const fixedNow = 1_700_000_000_000
const clock: Clock = { now: () => fixedNow }

const makeAuthStore = (): AuthStore => {
  const users = new Map<string, any>()
  const sessions = new Map<string, any>()
  return {
    async findUserByEmail(email) {
      for (const u of users.values()) if (u.email === email) return u
      return undefined
    },
    async getUser(id) {
      return users.get(id)
    },
    async insertUser(u) {
      users.set(u.id, u)
    },
    async confirmEmail(id) {
      const u = users.get(id)
      if (u) u.emailConfirmed = true
    },
    async insertSession(s) {
      sessions.set(s.id, s)
    },
    async getSession(id) {
      return sessions.get(id)
    },
    async revokeSession(id) {
      const s = sessions.get(id)
      if (s) s.revoked = true
    },
    async countRecentSignups() {
      return 0
    },
  }
}

describe('legacy scrypt verification branches (ECLASS-59)', () => {
  it('a legacy unversioned hash (salt$hash, default scrypt params) still verifies', async () => {
    const store = makeAuthStore()
    const { scryptSync, randomBytes } = await import('node:crypto')
    const salt = randomBytes(16)
    const legacyHash = `${salt.toString('hex')}$${scryptSync('longpass123', salt, 32).toString('hex')}`
    await store.insertUser({
      id: 'u-legacy',
      email: 'legacy@eclasstest.ru',
      passwordHash: legacyHash,
      emailConfirmed: true,
    })
    const svc = createAuthService({ store, clock, sessionTtlMs: 1000 })
    const res = await svc.login({ email: 'legacy@eclasstest.ru', password: 'longpass123' })
    expect(res.ok).toBe(true)
  })

  it('a malformed stored hash (no version, wrong arity) fails closed', async () => {
    const store = makeAuthStore()
    await store.insertUser({
      id: 'u-malformed',
      email: 'malformed@eclasstest.ru',
      passwordHash: 'garbage-not-a-hash',
      emailConfirmed: true,
    })
    const svc = createAuthService({ store, clock, sessionTtlMs: 1000 })
    const res = await svc.login({ email: 'malformed@eclasstest.ru', password: 'longpass123' })
    expect(res).toEqual({ ok: false, code: 'invalid_credentials' })
  })
})

describe('rate window unlock after expiry (ECLASS-59 unit)', () => {
  let now = fixedNow
  const mutableClock: Clock = { now: () => now }
  it('failures age out of the window and the account unlocks', async () => {
    const store = makeAuthStore()
    await store.insertUser({
      id: 'u-rate',
      email: 'rate@eclasstest.ru',
      passwordHash: 'irrelevant',
      emailConfirmed: true,
    })
    const svc = createAuthService({
      store,
      clock: mutableClock,
      sessionTtlMs: 1000,
      maxFailedAttempts: 3,
      rateLimitWindowMs: 1000,
    })
    for (let i = 0; i < 3; i++) {
      await svc.login({ email: 'rate@eclasstest.ru', password: 'wrong-wrong-1' })
    }
    const locked = await svc.login({ email: 'rate@eclasstest.ru', password: 'wrong-wrong-1' })
    expect(locked).toEqual({ ok: false, code: 'rate_limited' })

    now += 1001 // window passes
    const unlocked = await svc.login({ email: 'rate@eclasstest.ru', password: 'wrong-wrong-1' })
    expect(unlocked).not.toEqual({ ok: false, code: 'rate_limited' })
  })
})

integrationSuite('failure-branch proofs (email/reset/worker)', () => {
  beforeEach(() => {
    setEmailTransport(loggingTransport)
    return clearData()
  })
  afterEach(() => setEmailTransport(loggingTransport))

  it('email-confirm resend: job-create failure is logged and rethrown, user untouched', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('resendfail')
    const user = await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', emailConfirmed: false },
      overrideAccess: true,
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const failing = new Proxy(p as unknown as Record<string | symbol, unknown>, {
        get(target, prop) {
          if (prop !== 'create') return Reflect.get(target, prop)
          const orig = target.create as (args: { collection?: string }) => Promise<unknown>
          return async (args: { collection?: string }) => {
            if (args?.collection === 'email-jobs') throw new Error('job create boom')
            return orig.apply(target, [args])
          }
        },
      }) as unknown as Payload

      const confirm = createEmailConfirm({ payload: failing, clock: { now: () => Date.now() }, ttlMs: 1000 })
      await expect(confirm.resend(email)).rejects.toThrow('job create boom')
      expect(spy.mock.calls.some((c) => String(c[0]).includes('[resend] email-job create failed'))).toBe(true)

      // User hash untouched by the failed resend.
      const after = await p.findByID({ collection: 'users', id: user.id, overrideAccess: true })
      expect((after as unknown as { emailConfirmationTokenHash?: string | null }).emailConfirmationTokenHash ?? null).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('email-confirm confirm: transient WriteConflict exhausts retries and throws (route → 503)', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('exhaust')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', emailConfirmed: false },
      overrideAccess: true,
    })

    const conflict = Object.assign(new Error('WriteConflict'), { code: 112 })
    const attempts = { count: 0 }
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
                  if (name !== 'users') return orig(name)
                  return new Proxy(orig(name) as object, {
                    get(collTarget, collProp) {
                      if (collProp === 'updateOne') {
                        return async () => {
                          attempts.count++
                          throw conflict
                        }
                      }
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

    const confirm = createEmailConfirm({ payload: failing, clock: { now: () => Date.now() }, ttlMs: 1000 })
    await expect(confirm.confirm('some-token-value')).rejects.toThrow('WriteConflict')
    expect(attempts.count).toBe(3) // retried to exhaustion, not failed silently
  })

  it('password-reset request: job-create failure logs and rethrows (branch 97-98)', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('prfail')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', emailConfirmed: true },
      overrideAccess: true,
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const failing = new Proxy(p as unknown as Record<string | symbol, unknown>, {
        get(target, prop) {
          if (prop !== 'create') return Reflect.get(target, prop)
          const orig = target.create as (args: { collection?: string }) => Promise<unknown>
          return async (args: { collection?: string }) => {
            if (args?.collection === 'email-jobs') throw new Error('pr job boom')
            return orig.apply(target, [args])
          }
        },
      }) as unknown as Payload

      const service = createPasswordReset({ payload: failing, clock: { now: () => Date.now() }, ttlMs: 1000 })
      await expect(service.request(email)).rejects.toThrow('pr job boom')
    } finally {
      spy.mockRestore()
    }
  })

  it('worker: a job with a consumed (null) body fails terminally into lastError', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('consumed')
    await p.db.connection.collection('email-jobs').insertOne({
      userId: 'u-x',
      to: email,
      subject: 's',
      body: null, // e.g. a crashed terminal-write left it consumed but pending
      status: 'pending',
      attempts: 4, // next failure is terminal
      createdAt: Date.now(),
    })

    const result = await runEmailWorker({
      payload: p,
      transport: { send: async () => undefined },
      clock: { now: () => Date.now() },
      maxAttempts: 5,
    })
    expect(result.failed).toBe(1)
    const doc = await p.db.connection.collection('email-jobs').findOne({ to: email })
    expect(doc?.status).toBe('failed')
    expect(String(doc?.lastError)).toContain('job body already consumed')
  })
})
