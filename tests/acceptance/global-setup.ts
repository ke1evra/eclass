import type { FullConfig } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { getPayload } from 'payload'
import config from '../../src/payload.config'
import { seedContent } from '../../scripts/seed-content'

/**
 * Acceptance-suite global setup.
 *
 * 1. The auth mutations are rate-limited in a SHARED Mongo store
 *    (fail-closed), so buckets survive across local runs — cleared here to
 *    make reruns deterministic (CI boots a fresh replset anyway).
 * 2. The bank-driven tests need published demo questions. In CI the e2e job
 *    starts from an EMPTY database, so the idempotent seed runs here — the
 *    same code path the deployment uses (scripts/seed-content.ts).
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'mongodb://127.0.0.1:27018/eclass?replicaSet=rs0'
  const client = new MongoClient(url)
  await client.connect()
  try {
    await client.db().collection('rate-limits').deleteMany({})
  } finally {
    await client.close()
  }

  const payload = await getPayload({ config })
  const { created, total } = await seedContent(payload)
  console.log(`GLOBAL_SETUP seed: created=${created} bankTotal=${total}`)
}
