import { beforeEach, describe, expect, it } from 'vitest'
import { createSessionAdapter } from '@/auth/session-adapter'
import { resolveActor } from '@/auth/payload-resolver'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'

/**
 * ECLASS-65 / ECLASS-56 — session adapter + policy.
 *
 * Proves against real Mongo+Payload:
 *   - one login() creates exactly ONE session row
 *   - repeated login() creates independent sessions (not deduped, not replaced)
 *   - logout() revokes one session without affecting others
 *   - the login result NEVER contains hash / password / JWT / token in its
 *     serialized form — only the opaque sessionId (for the cookie) and userId
 */
const clock = { now: () => Date.now() }
const HOUR = 3_600_000

integrationSuite('ECLASS-65/56: session adapter policy', () => {
  beforeEach(async () => {
    await clearData()
  })

  it('one login creates exactly one session row', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('policy1')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })
    const adapter = createSessionAdapter({ payload: p, clock, sessionTtlMs: HOUR })

    const result = await adapter.login({ email, password: 'longpass123' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const sessions = await p.find({ collection: 'sessions', where: { userId: { equals: result.userId } }, overrideAccess: true })
    expect(sessions.totalDocs).toBe(1)
  })

  it('repeated login creates a SECOND independent session (both resolve)', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('policy2')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })
    const adapter = createSessionAdapter({ payload: p, clock, sessionTtlMs: HOUR })

    const r1 = await adapter.login({ email, password: 'longpass123' })
    const r2 = await adapter.login({ email, password: 'longpass123' })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return

    // Two distinct session ids.
    expect(r1.sessionId).not.toBe(r2.sessionId)

    // Both resolve to the same user.
    expect(await resolveActor(p, r1.sessionId, clock)).toEqual({ id: r1.userId, role: 'teacher' })
    expect(await resolveActor(p, r2.sessionId, clock)).toEqual({ id: r2.userId, role: 'teacher' })

    const sessions = await p.find({ collection: 'sessions', where: { userId: { equals: r1.userId } }, overrideAccess: true })
    expect(sessions.totalDocs).toBe(2)
  })

  it('logout revokes one session without affecting the other', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('policy3')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })
    const adapter = createSessionAdapter({ payload: p, clock, sessionTtlMs: HOUR })

    const r1 = await adapter.login({ email, password: 'longpass123' })
    const r2 = await adapter.login({ email, password: 'longpass123' })
    if (!r1.ok || !r2.ok) throw new Error('setup')

    await adapter.logout(r1.sessionId)
    expect(await resolveActor(p, r1.sessionId, clock)).toBeNull()
    expect(await resolveActor(p, r2.sessionId, clock)).toEqual({ id: r2.userId, role: 'teacher' })
  })

  it('login with wrong password returns invalid_credentials', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('policy4')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })
    const adapter = createSessionAdapter({ payload: p, clock, sessionTtlMs: HOUR })
    const result = await adapter.login({ email, password: 'wrong-pass-999' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid_credentials')
  })

  it('login with unconfirmed email returns email_not_confirmed', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('policy5')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', role: 'teacher', emailConfirmed: false },
      overrideAccess: true,
    })
    const adapter = createSessionAdapter({ payload: p, clock, sessionTtlMs: HOUR })
    const result = await adapter.login({ email, password: 'longpass123' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('email_not_confirmed')
  })

  it('login with a blocked user returns invalid_credentials', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('blocked')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', role: 'teacher', emailConfirmed: true, blocked: true },
      overrideAccess: true,
    })
    const adapter = createSessionAdapter({ payload: p, clock, sessionTtlMs: HOUR })
    const result = await adapter.login({ email, password: 'longpass123' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid_credentials')
  })

  it('logout on a non-existent session is a no-op (no throw)', async () => {
    const p = await getPayloadSingleton()
    const adapter = createSessionAdapter({ payload: p, clock, sessionTtlMs: HOUR })
    await expect(adapter.logout('nonexistent-session-id')).resolves.toBeUndefined()
  })

  it('the login result NEVER contains hash/password/JWT/token in serialized form', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('leak')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', role: 'teacher', emailConfirmed: true },
      overrideAccess: true,
    })
    const adapter = createSessionAdapter({ payload: p, clock, sessionTtlMs: HOUR })
    const result = await adapter.login({ email, password: 'longpass123' })
    if (!result.ok) throw new Error('login failed')

    const serialized = JSON.stringify(result)
    // The opaque sessionId IS in the result (it goes to the cookie) — that's
    // correct. But hash, password, and JWT must never appear.
    expect(serialized).not.toMatch(/hash|salt|scrypt|bcrypt/i)
    expect(serialized).not.toContain('longpass123')
    // No 'token' field and no JWT-like structure (eyJ...).
    expect(serialized).not.toMatch(/"token"/i)
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]/)
  })
})
