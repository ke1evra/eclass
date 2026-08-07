import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'

/**
 * ECLASS-65 — RESTART persistence proof.
 *
 * The reviewer's point: the "new process" claim in the earlier test was just
 * another call on the same Payload singleton — it did not prove persistence
 * across an actual restart. This test writes a session in the main process,
 * then resolves it from a SEPARATE Node child process (tsx) that boots Payload
 * against the same DATABASE_URL. If the session survives, persistence is real.
 */

const HOUR = 3_600_000

integrationSuite('ECLASS-65: resolveActor survives a process restart', () => {
  beforeEach(async () => {
    await clearData()
  })

  it('a session created here resolves in a separate process', async () => {
    const p = await getPayloadSingleton()
    const user = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('restart'), password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    })
    const sessionId = randomBytes(18).toString('base64url')
    await p.create({
      collection: 'sessions',
      data: { sessionId, userId: user.id, role: 'teacher', expiresAt: Date.now() + HOUR, revoked: false },
      overrideAccess: true,
    })

    // Hand the session id to a child process via a temp file; the child boots
    // its own Payload and reports the resolved actor back.
    const tmp = join(process.cwd(), '.restart-session.txt')
    writeFileSync(tmp, sessionId)
    const script = join(process.cwd(), 'scripts', 'restart-resolve.ts')

    const result = spawnSync(
      process.execPath,
      [require.resolve('tsx/cli'), script, tmp],
      {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout: 60_000,
      },
    )
    const out = (result.stdout || '') + (result.stderr || '')
    expect(result.status, out).toBe(0)
    // The child prints "RESOLVED <userId> <role>" on success.
    expect(out).toMatch(/RESOLVED \S+ teacher/)
    expect(out).toContain(user.id)
  })
})
