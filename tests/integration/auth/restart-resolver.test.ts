import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '../../../src/payload.config'
import { resolveActor } from '@/auth/payload-resolver'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'

/**
 * ECLASS-65 — DB-backed session resolution across Payload instances.
 *
 * IMPORTANT — what this proves and what it does NOT:
 *   PROVES: a session created via instance A is found via a SECOND Payload
 *           instance with its own connection to the same MongoDB. The data
 *           lives in the database, not in a per-instance Map.
 *   DOES NOT PROVE: survival of an actual process stop/restart. That invariant
 *                   is covered by the two-step CI job (seed → resolve in
 *                   separate processes) in ci.yml, NOT by this in-process test.
 *
 * The cross-process proof is deliberately split out of vitest because it must
 * run as genuinely separate Node processes (seed writes, exits; resolve boots
 * fresh against the same DB).
 */

const HOUR = 3_600_000

integrationSuite('ECLASS-65: session resolves across Payload instances (DB-backed)', () => {
  let secondInstance: Payload

  beforeEach(async () => {
    await clearData()
    secondInstance = await getPayload({
      config,
      key: `second-${Date.now()}-${randomBytes(4).toString('hex')}`,
    })
  })

  it('a session created in instance A is found via a second instance B', async () => {
    const primary = await getPayloadSingleton()
    const user = await primary.create({
      collection: 'users',
      data: { email: uniqueEmail('cross'), password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    })
    const sessionId = randomBytes(18).toString('base64url')
    await primary.create({
      collection: 'sessions',
      data: { sessionId, userId: user.id, role: 'teacher', expiresAt: Date.now() + HOUR, revoked: false },
      overrideAccess: true,
    })

    const clock = { now: () => Date.now() }
    const actor = await resolveActor(secondInstance, sessionId, clock)
    expect(actor).toEqual({ id: user.id, role: 'teacher' })

    // The second instance does NOT share the primary's in-memory state.
    expect(await resolveActor(secondInstance, 'never-existed', clock)).toBeNull()
  })
})
