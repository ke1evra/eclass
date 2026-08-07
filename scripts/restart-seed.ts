/**
 * ECLASS-65 cross-process restart proof — STEP 1 (seed).
 *
 * Runs as its OWN Node process (via `npx tsx`). Creates a user + session in
 * MongoDB, writes the opaque session id to a temp file (arg 1, 0600), then
 * EXITS. The temp file is the only hand-off to the resolver process.
 *
 * SECURITY: prints ONLY the userId (never the session token) — the token goes
 * exclusively to the temp file, which the CI step cleans via trap.
 *
 * Usage: npx tsx scripts/restart-seed.ts <session-file-path>
 *
 * Prints "SEEDED <userId>" on success.
 */
import { writeFileSync } from 'node:fs'
import { getPayload } from 'payload'
import { randomBytes } from 'node:crypto'
import config from '../src/payload.config'

const outFile = process.argv[2]
if (!outFile) {
  console.error('usage: restart-seed.ts <session-file>')
  process.exit(2)
}

const payload = await getPayload({ config })

const isTransientMongo = (err: unknown): boolean =>
  /catalog changes|IX lock|TransientTransaction/i.test(String(err))
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

writeFileSync(outFile, sessionId, { mode: 0o600 })
// Print ONLY the userId — the session token never goes to stdout/logs.
console.log(`SEEDED ${user.id}`)
await payload.destroy()
process.exit(0)
