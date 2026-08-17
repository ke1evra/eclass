import { afterAll, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '../../src/payload.config'

/**
 * Shared Payload harness for integration tests — ECLASS-56/62.
 *
 * Boots Payload once against DATABASE_URL (the same Mongo the CI replset
 * exposes). Tests get the `payload` instance and a `uniqueEmail` helper to
 * avoid collisions across runs. Skipped automatically when DATABASE_URL is
 * unset (local dev without Mongo), so these tests do not block `npm test` on a
 * developer machine without a DB.
 */
let payloadSingleton: Payload | null = null

export const hasMongo = !!process.env.DATABASE_URL

export const getPayloadSingleton = async (): Promise<Payload> => {
  if (!payloadSingleton) {
    payloadSingleton = await getPayload({ config })
  }
  return payloadSingleton
}

export const teardownPayload = async (): Promise<void> => {
  // payload.destroy() hangs on Mongo; just clear the singleton. Data lives in
  // the test DB and is cleaned per-test by the cleanup helper.
  payloadSingleton = null
}

let counter = 0
export const uniqueEmail = (prefix = 'u') => `${prefix}+${Date.now()}-${counter++}@eclasstest.ru`

export const integrationSuite = (name: string, fn: () => void) => {
  describe.skipIf(!hasMongo)(name, () => {
    beforeAll(async () => {
      await getPayloadSingleton()
    })
    afterAll(async () => {
      await teardownPayload()
    })
    fn()
  })
}

/**
 * Wipe the mutable collections between tests so each starts clean.
 * Uses overrideAccess (server-level cleanup), never exposed to clients.
 *
 * Mongo can throw "Unable to write to collection ... due to catalog changes"
 * when index builds refresh the catalog mid-write — transient on a freshly
 * initiated single-node replset (typical in CI). We retry on that specific
 * error so the test setup is stable.
 */
const isTransientMongo = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err)
  return /catalog changes|Unable to write to collection|IX lock|Transaction/i.test(msg)
}

const withMongoRetry = async <T>(fn: () => Promise<T>, attempts = 5): Promise<T> => {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === attempts - 1 || !isTransientMongo(err)) throw err
      await new Promise((r) => setTimeout(r, 150 * (i + 1)))
    }
  }
  throw new Error('unreachable')
}

export const clearData = async (): Promise<void> => {
  const p = await getPayloadSingleton()
  for (const slug of ['users', 'sessions', 'classes', 'memberships', 'invites', 'email-jobs', 'attempts', 'assignments', 'questions', 'attachments']) {
    await withMongoRetry(async () => {
      const { docs } = await p.find({ collection: slug, limit: 100, overrideAccess: true })
      for (const d of docs) {
        await p.delete({ collection: slug, id: d.id, overrideAccess: true })
      }
    })
  }
  // Raw Mongo collections (no Payload slug): rate-limit windows.
  await withMongoRetry(async () => {
    await payloadSingleton!.db.connection.collection('rate-limits').deleteMany({})
  })
}

export { withMongoRetry }

export type { Payload }
