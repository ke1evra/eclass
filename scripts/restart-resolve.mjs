/**
 * ECLASS-65 cross-process restart proof — STEP 2 (resolve).
 *
 * Runs as a SEPARATE Node process AFTER the seeder has exited. Reads the
 * opaque session id from the temp file (arg 1), boots its OWN Payload against
 * the same DATABASE_URL, and calls resolveActor. This is the real
 * process-restart proof: the seeder process is gone; if the session survives,
 * it lives in the database.
 *
 * Usage: node scripts/restart-resolve.mjs <session-file-path> <expected-user-id>
 *
 * Prints "RESOLVED <userId> <role>" on success, "ANONYMOUS" if not found.
 * Exits non-zero if the resolved actor does not match the expected user id.
 */
import { readFileSync } from 'node:fs'
import { getPayload } from 'payload'
import config from '../src/payload.config.ts'
import { resolveActor } from '../src/auth/payload-resolver.ts'

const sessionFile = process.argv[2]
const expectedUserId = process.argv[3]
if (!sessionFile || !expectedUserId) {
  console.error('usage: restart-resolve.mjs <session-file> <expected-user-id>')
  process.exit(2)
}

const sessionId = readFileSync(sessionFile, 'utf-8').trim()

const payload = await getPayload({ config })
const clock = { now: () => Date.now() }
const actor = await resolveActor(payload, sessionId, clock)

if (!actor) {
  console.log('ANONYMOUS')
  await payload.destroy()
  process.exit(1)
}
console.log(`RESOLVED ${actor.id} ${actor.role}`)
if (actor.id !== expectedUserId) {
  console.error(`MISMATCH: expected ${expectedUserId}, got ${actor.id}`)
  await payload.destroy()
  process.exit(1)
}
await payload.destroy()
process.exit(0)
