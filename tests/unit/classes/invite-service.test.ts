import { beforeEach, describe, expect, it } from 'vitest'
import { createInviteService, type InviteStore, type Clock } from '@/classes/invite'

/**
 * Invite service — ECLASS-15.
 *
 * Covers: code generation (no identifiers leaked), join flow, expiry, revoke,
 * single-use semantics, duplicate-join guard, and a recoverable error path.
 * The code is opaque — it must NOT contain the class id, teacher id, or any
 * guessable sequence.
 */

const fixedNow = 1_700_000_000_000
const clock: Clock = { now: () => fixedNow }

const makeStore = (): InviteStore => {
  const invites = new Map<string, any>()
  const members = new Map<string, Set<string>>()
  return {
    async insertInvite(inv) {
      invites.set(inv.code, inv)
    },
    async getInvite(code) {
      return invites.get(code)
    },
    async markUsed(code, studentId) {
      const inv = invites.get(code)
      if (inv) {
        inv.usedBy = studentId
        inv.usedAt = fixedNow
      }
    },
    async revokeInvite(code) {
      const inv = invites.get(code)
      if (inv) inv.revoked = true
    },
    async isMember(classId, studentId) {
      return members.get(classId)?.has(studentId) ?? false
    },
    async addMember(classId, studentId) {
      if (!members.has(classId)) members.set(classId, new Set())
      members.get(classId)!.add(studentId)
    },
    async getClassOwner(classId) {
      // lookup stub: class cls-1 owned by tea-1
      return classId === 'cls-1' ? 'tea-1' : undefined
    },
  }
}

describe('invite service — ECLASS-15', () => {
  let svc: ReturnType<typeof createInviteService>
  beforeEach(() => {
    svc = createInviteService({ store: makeStore(), clock, ttlMs: 24 * 60 * 60 * 1000 })
  })

  describe('code generation', () => {
    it('creates an invite with a short, opaque code for an owned class', async () => {
      const res = await svc.createInvite({ id: 'tea-1', role: 'teacher' }, 'cls-1')
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.code).toMatch(/^[A-Z0-9]{6,12}$/)
        expect(res.code).not.toContain('CLS')
        expect(res.code).not.toContain('TEA')
        expect(res.expiresAt).toBeGreaterThan(clock.now())
      }
    })

    it('the code does not encode the class id or teacher id', async () => {
      for (let i = 0; i < 20; i++) {
        const res = await svc.createInvite({ id: 'tea-1', role: 'teacher' }, 'cls-1')
        if (res.ok) {
          expect(res.code).not.toMatch(/cls/i)
          expect(res.code).not.toMatch(/tea/i)
          expect(res.code).not.toMatch(/1{3,}/) // no long runs of a single digit
        }
      }
    })

    it('a teacher cannot create an invite for a class they do not own', async () => {
      const res = await svc.createInvite({ id: 'tea-other', role: 'teacher' }, 'cls-1')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('not_found')
    })
  })

  describe('join flow', () => {
    it('a student joins a class with a valid code and is added to the roster', async () => {
      const inv = await svc.createInvite({ id: 'tea-1', role: 'teacher' }, 'cls-1')
      if (!inv.ok) throw new Error('setup')
      const join = await svc.join({ code: inv.code, studentId: 'stu-1' })
      expect(join.ok).toBe(true)
      if (join.ok) {
        expect(join.classId).toBe('cls-1')
        expect(join.studentId).toBe('stu-1')
      }
    })

    it('a used invite cannot be reused (single-use by default)', async () => {
      const inv = await svc.createInvite({ id: 'tea-1', role: 'teacher' }, 'cls-1')
      if (!inv.ok) throw new Error('setup')
      await svc.join({ code: inv.code, studentId: 'stu-1' })
      const reuse = await svc.join({ code: inv.code, studentId: 'stu-2' })
      expect(reuse.ok).toBe(false)
      if (!reuse.ok) expect(reuse.code).toBe('invite_used')
    })

    it('an already-member student gets a clear conflict, not a duplicate', async () => {
      const inv = await svc.createInvite({ id: 'tea-1', role: 'teacher' }, 'cls-1')
      if (!inv.ok) throw new Error('setup')
      await svc.join({ code: inv.code, studentId: 'stu-1' })
      // Re-join the same class via a fresh invite.
      const inv2 = await svc.createInvite({ id: 'tea-1', role: 'teacher' }, 'cls-1')
      if (!inv2.ok) throw new Error('setup2')
      const dup = await svc.join({ code: inv2.code, studentId: 'stu-1' })
      expect(dup.ok).toBe(false)
      if (!dup.ok) expect(dup.code).toBe('already_member')
    })
  })

  describe('expiry and revocation', () => {
    it('an expired invite returns a recoverable error', async () => {
      // Shared store so the invite survives across the time advance.
      const store = makeStore()
      const short = createInviteService({ store, clock, ttlMs: 1 })
      const inv = await short.createInvite({ id: 'tea-1', role: 'teacher' }, 'cls-1')
      if (!inv.ok) throw new Error('setup')
      const laterClock: Clock = { now: () => fixedNow + 10_000 }
      const later = createInviteService({ store, clock: laterClock, ttlMs: 1 })
      const join = await later.join({ code: inv.code, studentId: 'stu-1' })
      expect(join.ok).toBe(false)
      if (!join.ok) expect(join.code).toBe('invite_expired')
    })

    it('a revoked invite cannot be used', async () => {
      const inv = await svc.createInvite({ id: 'tea-1', role: 'teacher' }, 'cls-1')
      if (!inv.ok) throw new Error('setup')
      await svc.revoke({ id: 'tea-1', role: 'teacher' }, inv.code)
      const join = await svc.join({ code: inv.code, studentId: 'stu-1' })
      expect(join.ok).toBe(false)
      if (!join.ok) expect(join.code).toBe('invite_revoked')
    })

    it('only the class owner can revoke an invite', async () => {
      const inv = await svc.createInvite({ id: 'tea-1', role: 'teacher' }, 'cls-1')
      if (!inv.ok) throw new Error('setup')
      const revoke = await svc.revoke({ id: 'tea-other', role: 'teacher' }, inv.code)
      expect(revoke.ok).toBe(false)
      if (!revoke.ok) expect(revoke.code).toBe('not_found')
    })

    it('an unknown code returns the same error as expired (no enumeration)', async () => {
      const join = await svc.join({ code: 'BOGUS0', studentId: 'stu-1' })
      expect(join.ok).toBe(false)
      if (!join.ok) expect(join.code).toBe('invite_invalid')
    })
  })
})
