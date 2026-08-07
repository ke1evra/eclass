import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'

/**
 * ECLASS-65 — RESTART persistence proof.
 *
 * Writes a session in the main process, then resolves it from a SEPARATE Node
 * child process (tsx) that boots Payload against the same DATABASE_URL. Each
 * run uses a UNIQUE temp directory for the session-id file (no fixed path, no
 * token reuse) and cleans it up in a finally block — no races, no leftover
 * tokens on disk.
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

    // Unique temp dir per run; the session-id file lives only here and is
    // removed in finally so no token is left on disk or reused.
    const dir = mkdtempSync(join(tmpdir(), 'eclass-restart-'))
    const sessionFile = join(dir, `s-${randomBytes(4).toString('hex')}.txt`)
    writeFileSync(sessionFile, sessionId, { mode: 0o600 })
    const script = join(process.cwd(), 'scripts', 'restart-resolve.ts')

    try {
      // Resolve the tsx CLI with an ABSOLUTE path under the project's
      // node_modules (no PATH/shell/npx dependency — works identically on
      // macOS dev and the Linux GitHub runner). Run via the same node runtime
      // that executes this test (process.execPath).
      const tsxCli = join('node_modules', 'tsx', 'dist', 'cli.mjs')
      const result = spawnSync(
        process.execPath,
        [tsxCli, script, sessionFile],
        {
          encoding: 'utf-8',
          env: { ...process.env },
          timeout: 60_000,
          cwd: process.cwd(),
        },
      )
      const out = (result.stdout || '') + (result.stderr || '')
      expect(result.status, out).toBe(0)
      // The child prints "RESOLVED <userId> <role>" on success.
      expect(out).toMatch(/RESOLVED \S+ teacher/)
      expect(out).toContain(user.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
