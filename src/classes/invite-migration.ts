/**
 * One-time migration: legacy plaintext invite codes → sha256 — ECLASS-57.
 *
 * Rows written before invite-code hashing landed store the RAW 8-char code in
 * `invites.code`. This migration rewrites every such row to its sha256 hash so
 * the whole collection holds no plaintext codes. Idempotent: a row whose code
 * already looks like a 64-hex digest is skipped, so repeated runs are safe and
 * a hash is never hashed twice.
 *
 * Runs at app boot (src/instrumentation.ts) best-effort: a failure is LOUD in
 * the logs but does not kill the boot — undelivered legacy invites fail join
 * with invite_invalid and the teacher mints a fresh code (the safe direction).
 */
import type { Payload } from 'payload'
import { hashInviteCode } from './invite'

const HEX64 = /^[0-9a-f]{64}$/

export async function migrateInvitesToHashes(payload: Payload): Promise<number> {
  const invites = payload.db.connection.collection('invites')
  const rows = await invites.find({}).toArray()
  let migrated = 0
  for (const row of rows) {
    const code = row.code
    if (typeof code !== 'string' || HEX64.test(code)) continue
    await invites.updateOne({ _id: row._id }, { $set: { code: hashInviteCode(code) } })
    migrated++
  }
  return migrated
}
