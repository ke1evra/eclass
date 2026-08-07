import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'

/**
 * ECLASS-61 — Mongo replica set transaction proof.
 *
 * Connects to the URI from DATABASE_URL, runs a real transaction that commits,
 * and one that aborts. This proves the Mongo service in CI is a writable
 * replica set (transactions require a replset) and that the connection string
 * the app will use actually works.
 *
 * Skipped when DATABASE_URL is unset (local dev without Mongo) — but the
 * skip-registry (ECLASS-60) only scans tests/acceptance/**, so this intentional
 * skip does not violate the gate. In CI DATABASE_URL is always set.
 */
const URL = process.env.DATABASE_URL

const itIfMongo = URL ? it : it.skip

describe.skipIf(!URL)('MongoDB replica-set transaction — ECLASS-61', () => {
  let client: MongoClient

  beforeAll(async () => {
    client = new MongoClient(URL!)
    await client.connect()
  })

  afterAll(async () => {
    await client?.close()
  })

  itIfMongo('commits a two-document write inside a transaction', async () => {
    const db = client.db('eclass-tx-test')
    const a = db.collection('tx_a')
    const b = db.collection('tx_b')
    const session = client.startSession()
    try {
      session.startTransaction()
      await a.insertOne({ n: 1 }, { session })
      await b.insertOne({ n: 2 }, { session })
      await session.commitTransaction()
      expect(await a.countDocuments({ n: 1 })).toBeGreaterThanOrEqual(1)
      expect(await b.countDocuments({ n: 2 })).toBeGreaterThanOrEqual(1)
    } finally {
      await session.endSession()
      await a.deleteMany({})
      await b.deleteMany({})
    }
  })

  itIfMongo('aborts a transaction — no document is written', async () => {
    const db = client.db('eclass-tx-test')
    const c = db.collection('tx_abort')
    await c.deleteMany({})
    const session = client.startSession()
    try {
      session.startTransaction()
      await c.insertOne({ n: 999 }, { session })
      await session.abortTransaction()
      // Nothing should persist after an abort.
      expect(await c.countDocuments({})).toBe(0)
    } finally {
      await session.endSession()
    }
  })
})
