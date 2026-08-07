/**
 * ECLASS-65 cross-process restart proof — STEP 1 (seed).
 *
 * Runs as its OWN Node process. Creates a user + session in MongoDB, writes
 * the opaque session id to a temp file (arg 1), then EXITS. The temp file is
 * the only hand-off to the resolver process; it must have 0600 perms and be
 * cleaned by the caller.
 *
 * Usage: node scripts/restart-seed.mjs <session-file-path>
 *
 * Prints "SEEDED <userId> <sessionId>" on success.
 */
import { writeFileSync } from 'node:fs'
import { getPayload } from 'payload'
import { randomBytes } from 'node:crypto'
import config from '../src/payload.config.ts'

const outFile = process.argv[2]
if (!outFile) {
  console.error('usage: restart-seed.mjs <session-file>')
  process.exit(2)
}

const payload = await getPayload({ config })

// Mongo can throw "Unable to acquire IX lock ... due to catalog changes" right
// after index creation on a cold DB. Retry the create on that transient error.
const isTransientMongo = (err) => /catalog changes|IX lock|TransientTransaction/i.test(String(err))
const withRetry = async (fn, attempts = 6) => {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === attempts - 1 || !isTransientMongo(err)) throw err
      await new Promise((r) => setTimeout(r, 200 * (i + 1)))
    }
  }
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

// 0600 — only the owner can read the opaque session id.
writeFileSync(outFile, sessionId, { mode: 0o600 })
console.log(`SEEDED ${user.id} ${sessionId}`)
await payload.destroy()
process.exit(0)
