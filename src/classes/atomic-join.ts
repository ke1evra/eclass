/**
 * Atomic invite acceptance — ECLASS-57.
 *
 * The A7 join flow (invite code → student account → class membership) runs as
 * ONE Mongo transaction on the replica set:
 *
 *   1. create the student user (Payload Local API, req.transactionID —
 *      password hashing and hooks run inside the transaction);
 *   2. ATOMICALLY claim the invite: a single conditional updateOne on
 *      { code, revoked: false, expiresAt > now, usedBy: null } — exactly one
 *      concurrent caller matches (Payload's update-by-where is find-then-write
 *      and is NOT race-safe; see email-confirm.ts for the same lesson);
 *   3. insert the membership (unique index (classId, studentId) is the hard
 *      single-membership guarantee).
 *
 * Any failure aborts the transaction: no stranded user, no consumed invite, no
 * orphan membership — the partial-state invariant the task demands. Concurrency
 * losers get a specific, safe error code (invite_used / conflict).
 */
import type { Payload } from 'payload'
import { APIError } from 'payload'

export interface Clock {
  now(): number
}

export type JoinErrorCode =
  | 'validation_error'
  | 'invite_invalid'
  | 'invite_expired'
  | 'invite_revoked'
  | 'invite_used'
  | 'already_member'
  | 'conflict'
  | 'error'

export type JoinResult =
  | { ok: true; classId: string; studentId: string }
  | { ok: false; code: JoinErrorCode }

export interface AtomicJoinOptions {
  payload: Payload
  clock: Clock
}

export interface JoinInput {
  code: string
  /** Student login (email-shaped identifier; NOT disclosed anywhere). */
  login: string
  displayName: string
  password: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isDuplicate = (err: unknown): boolean =>
  err instanceof APIError && (err as { status?: number }).status === 400

/**
 * A single-node replset serializes conflicting transactions with a
 * TransientTransactionError / WriteConflict (code 112): the instruction from
 * the server is to RETRY the whole transaction. Retrying is safe — an aborted
 * attempt leaves nothing behind, and on retry the atomic claim either wins or
 * sees usedBy already set (→ invite_used).
 */
const isTransientTxError = (err: unknown): boolean => {
  const code = (err as { code?: number }).code
  const labels = (err as { errorLabels?: string[] }).errorLabels
  return (
    code === 112 ||
    Boolean(labels?.includes('TransientTransactionError')) ||
    Boolean(labels?.includes('UnknownTransactionCommitResult'))
  )
}

export function createAtomicJoin(opts: AtomicJoinOptions) {
  const { payload, clock } = opts

  /** Fresh read of the invite for a specific (non-enumerating-per-class) error code. */
  const rediagose = async (code: string): Promise<JoinErrorCode> => {
    const inv = await payload.db.connection.collection('invites').findOne({ code })
    if (!inv) return 'invite_invalid'
    if (inv.revoked) return 'invite_revoked'
    if (typeof inv.expiresAt === 'number' && clock.now() >= inv.expiresAt) return 'invite_expired'
    if (inv.usedBy) return 'invite_used'
    return 'error'
  }

  return {
    /**
     * Accept an invite, creating the student account and the membership in one
     * transaction. Students are created emailConfirmed (the teacher's invite is
     * the trust anchor — ECLASS-15) with role 'student' via the trusted Local
     * API path; the Users beforeChange role-freeze applies to client requests,
     * this is the server boundary.
     */
    async acceptInviteAndCreateStudent(input: JoinInput): Promise<JoinResult> {
      const code = input.code?.trim().toUpperCase()
      if (!code || code.length > 64) return { ok: false, code: 'validation_error' }
      if (!EMAIL_RE.test(input.login ?? '')) return { ok: false, code: 'validation_error' }
      if (!input.displayName?.trim() || input.displayName.trim().length > 120)
        return { ok: false, code: 'validation_error' }
      if (!input.password || input.password.length < 8) return { ok: false, code: 'validation_error' }

      const now = clock.now()

      // Pre-read outside the transaction ONLY to pick the specific error code
      // early (better UX); the authoritative check is the atomic claim below.
      const pre = await payload.db.connection.collection('invites').findOne({ code })
      if (!pre) return { ok: false, code: 'invite_invalid' }
      if (pre.revoked) return { ok: false, code: 'invite_revoked' }
      if (typeof pre.expiresAt === 'number' && now >= pre.expiresAt)
        return { ok: false, code: 'invite_expired' }
      if (pre.usedBy) return { ok: false, code: 'invite_used' }
      const classId = pre.classId as string
      if (!classId) return { ok: false, code: 'invite_invalid' }

      /** One full transaction attempt; rolls back on ANY failure path. */
      const attemptTx = async (): Promise<JoinResult> => {
        const transactionID = await payload.db.beginTransaction()
        if (!transactionID) return { ok: false, code: 'error' }
        const session = (payload.db as unknown as {
          sessions: Record<string, import('mongoose').ClientSession>
        }).sessions[transactionID]
        if (!session) return { ok: false, code: 'error' }

        try {
          const user = await payload.create({
            collection: 'users',
            data: {
              email: input.login.toLowerCase(),
              password: input.password,
              name: input.displayName.trim(),
              role: 'student',
              emailConfirmed: true,
            },
            overrideAccess: true,
            req: { transactionID },
          })

          const claimed = await payload.db.connection.collection('invites').updateOne(
            { code, revoked: false, expiresAt: { $gt: now }, usedBy: null },
            { $set: { usedBy: String(user.id), usedAt: now } },
            { session },
          )
          if (claimed.matchedCount !== 1) {
            await payload.db.rollbackTransaction(transactionID)
            return { ok: false, code: await rediagose(code) }
          }

          // Unique index (classId, studentId) makes this insert the final
          // single-membership guard; E11000 aborts the whole transaction.
          await payload.db.connection
            .collection('memberships')
            .insertOne({ classId, studentId: String(user.id) }, { session })

          await payload.db.commitTransaction(transactionID)
          return { ok: true, classId, studentId: String(user.id) }
        } catch (err) {
          try {
            await payload.db.rollbackTransaction(transactionID)
          } catch {
            // The transaction is already dead; the original error is the signal.
          }
          throw err
        }
      }

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await attemptTx()
        } catch (err) {
          if (isTransientTxError(err) && attempt < 3) continue
          if (isDuplicate(err)) return { ok: false, code: 'conflict' }
          if ((err as { code?: number }).code === 11_000) return { ok: false, code: 'already_member' }
          throw err
        }
      }
      return { ok: false, code: 'error' }
    },
  }
}
