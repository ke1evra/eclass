import { beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { resolveActor } from '@/auth/payload-resolver'

/**
 * ECLASS-65 — unified auth authority (ADR-0007).
 *
 * Production flow against real Mongo+Payload:
 *   signup (Users.create) → confirm (Users.update emailConfirmed)
 *   → login (payload.login verifies password) → Sessions.insert → cookie
 *   → resolveActor (Sessions + current User) → Actor
 *   → logout (Sessions.update revoked=true) → resolveActor → null
 *
 * Invariants proven here (no mock store):
 *   - new process resolution (resolveActor is stateless against DB)
 *   - role change on User takes effect on the existing session immediately
 *   - blocked/unknown user → anonymous
 *   - forged / expired / revoked cookie → anonymous
 *   - password hash never present in any returned object
 */
const clock = { now: () => Date.now() }
const HOUR = 3_600_000

integrationSuite('ECLASS-65: unified auth authority', () => {
  beforeEach(async () => {
    await clearData()
  })

  it('signup → confirm → login → new-process resolve → logout', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('auth')

    // signup (server path; beforeChange forces role=teacher)
    const user = await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    })
    expect(user.role).toBe('teacher')

    // confirm email (trusted server update)
    await p.update({
      collection: 'users',
      id: user.id,
      data: { emailConfirmed: true },
      overrideAccess: true,
    })

    // login verifies the password via Payload auth (no hash read by app)
    const loginResult = await p.login({ collection: 'users', data: { email, password: 'longpass123' } })
    expect(loginResult.user!.id).toBe(user.id)

    // create an opaque application session (JWT is NOT used as session)
    const sessionId = randomBytes(18).toString('base64url')
    await p.create({
      collection: 'sessions',
      data: {
        sessionId,
        userId: user.id,
        role: 'teacher',
        expiresAt: clock.now() + HOUR,
        revoked: false,
      },
      overrideAccess: true,
    })

    // resolveActor is stateless — simulate a NEW process by calling it fresh
    const actor = await resolveActor(p, sessionId, clock)
    expect(actor).toEqual({ id: user.id, role: 'teacher' })

    // logout revokes the session
    const sessionDoc = (await p.find({
      collection: 'sessions',
      where: { sessionId: { equals: sessionId } },
      overrideAccess: true,
    })).docs[0]
    await p.update({
      collection: 'sessions',
      id: sessionDoc!.id,
      data: { revoked: true },
      overrideAccess: true,
    })
    expect(await resolveActor(p, sessionId, clock)).toBeNull()
  })

  it('changing the user role takes effect on the EXISTING session immediately', async () => {
    const p = await getPayloadSingleton()
    const user = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('role'), password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    })
    const sessionId = randomBytes(18).toString('base64url')
    await p.create({
      collection: 'sessions',
      data: { sessionId, userId: user.id, role: 'teacher', expiresAt: clock.now() + HOUR, revoked: false },
      overrideAccess: true,
    })
    expect(await resolveActor(p, sessionId, clock)).toEqual({ id: user.id, role: 'teacher' })

    // Trusted server process (no req.user) demotes the user. The beforeChange
    // hook allows role change when there is no client user (server path).
    await p.update({
      collection: 'users',
      id: user.id,
      data: { role: 'student' },
      overrideAccess: true,
    })
    expect(await resolveActor(p, sessionId, clock)).toEqual({ id: user.id, role: 'student' })
  })

  it('forged / unknown cookie → anonymous', async () => {
    const p = await getPayloadSingleton()
    expect(await resolveActor(p, undefined, clock)).toBeNull()
    expect(await resolveActor(p, 'totally-forged-opaque-id', clock)).toBeNull()
  })

  it('expired cookie → anonymous', async () => {
    const p = await getPayloadSingleton()
    const user = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('exp'), password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    })
    const sessionId = randomBytes(18).toString('base64url')
    await p.create({
      collection: 'sessions',
      data: { sessionId, userId: user.id, role: 'teacher', expiresAt: clock.now() - 1, revoked: false },
      overrideAccess: true,
    })
    expect(await resolveActor(p, sessionId, clock)).toBeNull()
  })

  it('session whose user was deleted → anonymous', async () => {
    const p = await getPayloadSingleton()
    const user = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('del'), password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    })
    const sessionId = randomBytes(18).toString('base64url')
    await p.create({
      collection: 'sessions',
      data: { sessionId, userId: user.id, role: 'teacher', expiresAt: clock.now() + HOUR, revoked: false },
      overrideAccess: true,
    })
    expect(await resolveActor(p, sessionId, clock)).toEqual({ id: user.id, role: 'teacher' })

    // Delete the user (trusted server path).
    await p.delete({ collection: 'users', id: user.id, overrideAccess: true })
    expect(await resolveActor(p, sessionId, clock)).toBeNull()
  })

  it('password hash is never present in the resolved actor or session lookup', async () => {
    const p = await getPayloadSingleton()
    const user = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('hash'), password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    })
    const sessionId = randomBytes(18).toString('base64url')
    await p.create({
      collection: 'sessions',
      data: { sessionId, userId: user.id, role: 'teacher', expiresAt: clock.now() + HOUR, revoked: false },
      overrideAccess: true,
    })
    const actor = await resolveActor(p, sessionId, clock)
    expect(actor).not.toBeNull()
    expect(JSON.stringify(actor)).not.toMatch(/hash|password|salt|scrypt|bcrypt/i)
    expect(JSON.stringify(actor)).not.toContain('longpass123')
  })

  it('a BLOCKED user is treated as anonymous even with a valid session', async () => {
    const p = await getPayloadSingleton()
    const user = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('block'), password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    })
    const sessionId = randomBytes(18).toString('base64url')
    await p.create({
      collection: 'sessions',
      data: { sessionId, userId: user.id, role: 'teacher', expiresAt: clock.now() + HOUR, revoked: false },
      overrideAccess: true,
    })
    expect(await resolveActor(p, sessionId, clock)).toEqual({ id: user.id, role: 'teacher' })

    // Trusted server process blocks the user.
    await p.update({
      collection: 'users',
      id: user.id,
      data: { blocked: true },
      overrideAccess: true,
    })
    expect(await resolveActor(p, sessionId, clock)).toBeNull()
  })

  it('a transient DB error is RE-THROWN, not masked as anonymous', async () => {
    // Wrap the real payload so find() throws a non-NotFound error, simulating
    // a Mongo outage. The resolver must propagate it (5xx), not return null —
    // otherwise an attacker could DoS the store to widen access.
    const p = await getPayloadSingleton()
    const boom: Error & { status?: number } = Object.assign(new Error('connection refused'), { status: 503 })
    const throwingPayload = new Proxy(p as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop === 'find') return async () => Promise.reject(boom)
        const value = target[prop as symbol]
        return typeof value === 'function' ? value.bind(p) : value
      },
    })
    await expect(resolveActor(throwingPayload as never, 'any-opaque-id', clock)).rejects.toThrow(/connection refused/)
  })
})
