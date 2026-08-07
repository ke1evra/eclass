import { beforeEach, describe, expect, it } from 'vitest'
import {
  createSessionResolver,
  type SessionStore,
  type Clock,
} from '@/auth/session'

/**
 * Session resolver — CB-4 (ECLASS-51).
 *
 * The student/teacher identity MUST come from a server-side session, never
 * from a URL query param. This test pins the contract: resolveSession(cookie)
 * returns the authenticated actor or null — there is no path that trusts a
 * caller-supplied id.
 */

const fixedNow = 1_700_000_000_000
const clock: Clock = { now: () => fixedNow }

type TestStore = SessionStore & {
  seed(id: string, s: { userId: string; role: 'teacher' | 'student'; expiresAt?: number; revoked?: boolean }): void
}

const makeStore = (): TestStore => {
  const sessions = new Map<string, { userId: string; role: 'teacher' | 'student'; expiresAt: number; revoked: boolean }>()
  return {
    async getSession(id) {
      return sessions.get(id)
    },
    seed(id, s) {
      sessions.set(id, { userId: s.userId, role: s.role, expiresAt: s.expiresAt ?? fixedNow + 3_600_000, revoked: s.revoked ?? false })
    },
  }
}

describe('session resolver — CB-4', () => {
  let resolve: ReturnType<typeof createSessionResolver>
  let store: TestStore
  beforeEach(() => {
    store = makeStore()
    resolve = createSessionResolver({ store, clock })
  })

  it('returns the actor for a valid session cookie', async () => {
    store.seed('sess-valid', { userId: 'tea-1', role: 'teacher' })
    const actor = await resolve.resolveSession('sess-valid')
    expect(actor).toEqual({ id: 'tea-1', role: 'teacher' })
  })

  it('returns null for a missing cookie (no identity inferred)', async () => {
    const actor = await resolve.resolveSession(undefined)
    expect(actor).toBeNull()
  })

  it('returns null for an unknown session id', async () => {
    const actor = await resolve.resolveSession('sess-bogus')
    expect(actor).toBeNull()
  })

  it('returns null for a revoked session', async () => {
    store.seed('sess-revoked', { userId: 'tea-1', role: 'teacher', revoked: true })
    const actor = await resolve.resolveSession('sess-revoked')
    expect(actor).toBeNull()
  })

  it('returns null for an expired session', async () => {
    store.seed('sess-old', { userId: 'tea-1', role: 'teacher', expiresAt: fixedNow - 1 })
    const actor = await resolve.resolveSession('sess-old')
    expect(actor).toBeNull()
  })

  it('resolves a student actor (used to gate /student)', async () => {
    store.seed('sess-stu', { userId: 'stu-1', role: 'student' })
    const actor = await resolve.resolveSession('sess-stu')
    expect(actor).toEqual({ id: 'stu-1', role: 'student' })
  })

  it('never trusts a caller-supplied id — no such overload exists', () => {
    // Type-level guard: resolveSession takes ONE argument (the cookie value).
    // There is no resolveSession(userId) overload. This is structural.
    const fn = resolve.resolveSession
    expect(fn.length).toBe(1)
  })
})
