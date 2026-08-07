/**
 * Invite service — ECLASS-15 (TDD-P1-03).
 *
 * Opaque, single-use invite codes that let a student join a class from a phone
 * without searching for a school. Security properties baked in:
 *
 *   - the code is a random short string; it does NOT encode class id, teacher
 *     id, or any guessable sequence (acceptance: "код не раскрывает
 *     идентификаторы класса или учителя");
 *   - invites expire (default 24h) and can be revoked by the owner;
 *   - a used invite cannot be reused; an already-member gets a clear conflict;
 *   - unknown / expired / revoked codes return distinguishable codes so the UI
 *     can offer a recovery path ("ask the teacher for a new code").
 */
import { randomBytes } from 'node:crypto'

export interface Clock {
  now(): number
}

export interface InviteRecord {
  code: string
  classId: string
  ownerId: string
  createdAt: number
  expiresAt: number
  usedBy?: string
  usedAt?: number
  revoked: boolean
}

export interface InviteStore {
  insertInvite(inv: InviteRecord): Promise<void>
  getInvite(code: string): Promise<InviteRecord | undefined>
  markUsed(code: string, studentId: string): Promise<void>
  revokeInvite(code: string): Promise<void>
  isMember(classId: string, studentId: string): Promise<boolean>
  addMember(classId: string, studentId: string): Promise<void>
  /** Returns the ownerId of a class, or undefined if it does not exist. */
  getClassOwner(classId: string): Promise<string | undefined>
}

export type InviteResult<T> = ({ ok: true } & T) | { ok: false; code: InviteErrorCode }

export type InviteErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invite_invalid'
  | 'invite_expired'
  | 'invite_revoked'
  | 'invite_used'
  | 'already_member'
  | 'validation_error'

interface Options {
  store: InviteStore
  clock: Clock
  ttlMs: number
}

/** Generate an opaque, unguessable, human-friendly code (base32-ish, no ambiguous chars). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I,O,0,1
const generateCode = (len = 8): string => {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length]
  }
  return out
}

export function createInviteService(opts: Options) {
  const { store, clock, ttlMs } = opts

  return {
    async createInvite(
      actor: { id: string; role: string },
      classId: string,
    ): Promise<InviteResult<{ code: string; expiresAt: number }>> {
      // Only a teacher may mint invites. A student actor is refused outright.
      if (actor.role !== 'teacher') return { ok: false, code: 'forbidden' }
      const realOwner = await store.getClassOwner(classId)
      if (realOwner !== actor.id) return { ok: false, code: 'not_found' }

      const now = clock.now()
      const code = generateCode()
      await store.insertInvite({
        code,
        classId,
        ownerId: actor.id,
        createdAt: now,
        expiresAt: now + ttlMs,
        revoked: false,
      })
      return { ok: true, code, expiresAt: now + ttlMs }
    },

    async join(input: { code: string; studentId: string }): Promise<InviteResult<{ classId: string; studentId: string }>> {
      if (!input.code || !input.studentId) return { ok: false, code: 'validation_error' }
      const inv = await store.getInvite(input.code)
      // Unknown code → invalid (do not leak existence differently from expired).
      if (!inv) return { ok: false, code: 'invite_invalid' }
      if (inv.revoked) return { ok: false, code: 'invite_revoked' }
      if (clock.now() >= inv.expiresAt) return { ok: false, code: 'invite_expired' }
      if (inv.usedBy) return { ok: false, code: 'invite_used' }

      if (await store.isMember(inv.classId, input.studentId)) {
        return { ok: false, code: 'already_member' }
      }

      await store.addMember(inv.classId, input.studentId)
      await store.markUsed(inv.code, input.studentId)
      return { ok: true, classId: inv.classId, studentId: input.studentId }
    },

    async revoke(
      actor: { id: string; role: string },
      code: string,
    ): Promise<InviteResult<{ revoked: true }>> {
      if (actor.role !== 'teacher') return { ok: false, code: 'forbidden' }
      const inv = await store.getInvite(code)
      if (!inv || inv.ownerId !== actor.id) return { ok: false, code: 'not_found' }
      await store.revokeInvite(code)
      return { ok: true, revoked: true }
    },
  }
}
