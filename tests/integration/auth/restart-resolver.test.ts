import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '../../../src/payload.config'
import { resolveActor } from '@/auth/payload-resolver'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'

/**
 * ECLASS-65 — RESTART persistence proof.
 *
 * A "restart" means a FRESH application context: a new Payload instance with
 * its OWN connection to the same MongoDB, NOT the cached singleton. We boot a
 * second Payload with a unique `key` (so Payload's singleton cache returns a
 * distinct instance with a fresh mongoose connection) and resolve a session
 * created in the primary instance through it.
 *
 * This proves the session survives across application contexts against the real
 * database — without the brittleness of spawning a child process (which was
 * exit-code-13-flaky across Node 24 / tsx / PATH on the CI runner). If the
 * session were stored in a Map (the old in-memory wiring), the second instance
 * would NOT find it.
 */

const HOUR = 3_600_000

integrationSuite('ECLASS-65: resolveActor survives an application restart', () => {
  let restartedPayload: Payload

  beforeEach(async () => {
    await clearData()
    // Boot a fresh Payload instance with a unique key — Payload caches by key,
    // so this returns a NEW instance with its own DB connection, modelling a
    // restarted process against the same DATABASE_URL.
    restartedPayload = await getPayload({
      config,
      key: `restart-${Date.now()}-${randomBytes(4).toString('hex')}`,
    })
  })

  it('a session created in instance A resolves in a freshly-booted instance B', async () => {
    const primary = await getPayloadSingleton()
    const user = await primary.create({
      collection: 'users',
      data: { email: uniqueEmail('restart'), password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    })
    const sessionId = randomBytes(18).toString('base64url')
    await primary.create({
      collection: 'sessions',
      data: { sessionId, userId: user.id, role: 'teacher', expiresAt: Date.now() + HOUR, revoked: false },
      overrideAccess: true,
    })

    // Resolve through the RESTARTED instance — independent connection, same DB.
    const clock = { now: () => Date.now() }
    const actor = await resolveActor(restartedPayload, sessionId, clock)
    expect(actor).toEqual({ id: user.id, role: 'teacher' })

    // Sanity: an unknown session still resolves to null through the restarted
    // instance (it is not sharing the primary's in-memory state).
    expect(await resolveActor(restartedPayload, 'never-existed', clock)).toBeNull()
  })
})
