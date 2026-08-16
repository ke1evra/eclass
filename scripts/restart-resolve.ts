/**
 * ECLASS-65 cross-process restart proof — STEP 2 (resolve).
 *
 * Runs as a SEPARATE Node process AFTER the seeder has EXITED. Reads the
 * opaque session id from the temp file (arg 1), boots its OWN Payload against
 * the same DATABASE_URL, and calls resolveActor. The seeder process is gone;
 * if the session resolves, it lives in MongoDB — the restart invariant.
 *
 * SECURITY: prints ONLY the userId + role (RESOLVED <id> <role> / ANONYMOUS) —
 * the session token never reaches stdout/stderr/logs.
 *
 * FAILURE VISIBILITY: same pattern as restart-seed.ts — main().catch prints to
 * stderr (exit 1) and a 25s watchdog fires if the Payload boot never settles,
 * instead of Node's silent exit-13 with empty output.
 *
 * Usage: npx tsx scripts/restart-resolve.ts <session-file> <expected-user-id>
 */
import { readFileSync } from 'node:fs'
import { getPayload } from 'payload'
import config from '../src/payload.config'
import { resolveActor } from '../src/auth/payload-resolver'

const main = async (): Promise<void> => {
  const sessionFile = process.argv[2]
  const expectedUserId = process.argv[3]
  if (!sessionFile || !expectedUserId) {
    throw new Error('usage: restart-resolve.ts <session-file> <expected-user-id>')
  }

  const sessionId = readFileSync(sessionFile, 'utf-8').trim()
  const payload = await getPayload({ config })
  const clock = { now: () => Date.now() }
  const actor = await resolveActor(payload, sessionId, clock)

  if (!actor) {
    console.log('ANONYMOUS')
    await Promise.race([
      payload.destroy(),
      new Promise((r) => setTimeout(r, 3000)),
    ])
    process.exit(1)
  }

  console.log(`RESOLVED ${actor.id} ${actor.role}`)
  await Promise.race([
    payload.destroy(),
    new Promise((r) => setTimeout(r, 3000)),
  ])
  if (actor.id !== expectedUserId) {
    console.error(`MISMATCH: expected ${expectedUserId}, got ${actor.id}`)
    process.exit(1)
  }
}

const watchdog = setTimeout(() => {
  console.error('RESOLVE FAILED: watchdog — process did not complete within 25s (boot hang?)')
  process.exit(1)
}, 25_000)

main()
  .then(() => {
    clearTimeout(watchdog)
    process.exit(0)
  })
  .catch((err) => {
    clearTimeout(watchdog)
    console.error(`RESOLVE FAILED: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
