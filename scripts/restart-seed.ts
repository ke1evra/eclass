/**
 * ECLASS-65 cross-process restart proof — STEP 1 (seed).
 *
 * Runs as its OWN Node process (via `npx tsx`). Creates a user + session in
 * MongoDB, writes the opaque session id to `<output-dir>/session` (0600), then
 * EXITS. The temp file is the only hand-off to the resolver process — this
 * process is GONE before step 2 boots, which is the point of the proof: the
 * data must live in the DB, not in any surviving process's memory.
 *
 * SECURITY: prints ONLY the userId (SEEDED <userId>) — the session token never
 * reaches stdout/stderr/logs.
 *
 * FAILURE VISIBILITY: earlier CI runs sometimes exited with code 13
 * (Node's "Unfinished Top-Level Await") and EMPTY output when the Payload boot
 * never settled — the failure was invisible. This script therefore wraps the
 * work in main() with .catch printing to stderr (exit 1) and a watchdog that
 * fires if the process has not completed in 25s. Either way, the failure is
 * visible in diagnostics.
 *
 * Usage: npx tsx scripts/restart-seed.ts <output-dir>
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPayload } from 'payload'
import { randomBytes } from 'node:crypto'
import config from '../src/payload.config'

const main = async (): Promise<void> => {
  const dir = process.argv[2]
  if (!dir) throw new Error('usage: restart-seed.ts <output-dir>')

  const payload = await getPayload({ config })

  const isTransientMongo = (err: unknown): boolean =>
    /catalog changes|IX lock|TransientTransaction|E11000|WriteConflict/i.test(String(err))
  const withRetry = async <T>(fn: () => Promise<T>, attempts = 6): Promise<T> => {
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn()
      } catch (err) {
        if (i === attempts - 1 || !isTransientMongo(err)) throw err
        await new Promise((r) => setTimeout(r, 200 * (i + 1)))
      }
    }
    throw new Error('unreachable')
  }

  const email = `restart+${Date.now()}-${randomBytes(3).toString('hex')}@eclasstest.ru`
  const user = await withRetry(() =>
    payload.create({
      collection: 'users',
      data: { email, password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    }),
  )
  const sessionId = randomBytes(18).toString('base64url')
  await withRetry(() =>
    payload.create({
      collection: 'sessions',
      data: {
        sessionId,
        userId: user.id,
        role: 'teacher',
        expiresAt: Date.now() + 3_600_000,
        revoked: false,
      },
      overrideAccess: true,
    }),
  )

  writeFileSync(join(dir, 'session'), sessionId, { mode: 0o600 })
  // Print ONLY the userId — the session token never goes to stdout/logs.
  console.log(`SEEDED ${user.id}`)

  // destroy() can hang on Mongo; race it so the data (already committed) is
  // what matters, then exit cleanly.
  await Promise.race([
    payload.destroy(),
    new Promise((r) => setTimeout(r, 3000)),
  ])
}

const watchdog = setTimeout(() => {
  console.error('SEED FAILED: watchdog — process did not complete within 25s (boot hang?)')
  process.exit(1)
}, 25_000)

main()
  .then(() => {
    clearTimeout(watchdog)
    process.exit(0)
  })
  .catch((err) => {
    clearTimeout(watchdog)
    console.error(`SEED FAILED: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
