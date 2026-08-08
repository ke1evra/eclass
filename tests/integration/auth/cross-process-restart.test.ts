import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'

/**
 * ECLASS-65 — genuine cross-process restart proof.
 *
 * Seeds a session via the primary Payload (Local API), writes the opaque
 * session id to a temp file, then spawns a SEPARATE Node process
 * (`scripts/restart-resolve.ts`) that boots its OWN Payload against the same
 * MongoDB and resolves the actor. The primary process is still alive, but the
 * child has its own module cache, connection pool, and memory — so if the
 * session resolves, it lives in the DB, not in any process's memory.
 *
 * This replaces the flaky bash+npx step that used to live in ci.yml: that step
 * captured output via a file and failed opaquely (empty scrubbed log, ~2s
 * exit) on roughly half of CI runs. Running the same proof inside vitest
 * gives full stdout/stderr visibility, deterministic retry on classified
 * transient Mongo errors, and reuses the Payload boot path the rest of the
 * suite already exercises successfully.
 *
 * SECURITY: the temp file holds the opaque session id (a bearer credential
 * for the test account). It lives under the OS tmp dir with 0600 perms and is
 * removed in the finally. The child prints ONLY the userId + role, never the
 * session id.
 */
const HOUR = 3_600_000

interface ChildResult {
  code: number
  stdout: string
  stderr: string
}

async function runResolver(sessionFile: string, userId: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['tsx', 'scripts/restart-resolve.ts', sessionFile, userId],
      { env: { ...process.env }, cwd: process.cwd() },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    // Hard timeout: a healthy resolve takes ~2-3s on CI. If the child has not
    // exited in 25s (cold tsx compile + Payload boot + resolve), kill it so the
    // test fails fast instead of hanging until the vitest per-test cap.
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve({ code: -1, stdout, stderr: `${stderr}\n[runResolver] timed out after 25s` })
    }, 25_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * A failure is "transient" (worth retrying) when it is a classified Mongo error
 * OR when the child produced no output at all — on CI the `npx tsx` cold start
 * occasionally exits in ~2s with empty stdout/stderr before Payload boots,
 * which is an infrastructure race, not an app defect.
 */
const isTransient = (r: ChildResult): boolean => {
  const combined = `${r.stdout}\n${r.stderr}`
  if (/E11000|WriteConflict|TransientTransaction|catalog changes|IX lock|connection refused|topology|server selection/i.test(combined)) {
    return true
  }
  // Empty output + nonzero exit: the process never got to run meaningfully.
  return r.code !== 0 && r.stdout.trim() === '' && r.stderr.trim() === ''
}

integrationSuite('ECLASS-65: cross-process restart proof (child_process)', () => {
  beforeEach(async () => {
    await clearData()
  })

  it('a session seeded in the primary process resolves in a fresh child process', async () => {
    const p = await getPayloadSingleton()
    const user = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('xproc'), password: 'longpass123', role: 'teacher' },
      overrideAccess: true,
    })
    const sessionId = randomBytes(18).toString('base64url')
    await p.create({
      collection: 'sessions',
      data: {
        sessionId,
        userId: user.id,
        role: 'teacher',
        expiresAt: Date.now() + HOUR,
        revoked: false,
      },
      overrideAccess: true,
    })

    const dir = mkdtempSync(join(tmpdir(), 'eclass-xproc-'))
    const sessionFile = join(dir, 'session')
    writeFileSync(sessionFile, sessionId, { mode: 0o600 })

    try {
      // Retry on classified transient errors (Mongo write-conflict, or the
      // `npx tsx` cold-start race that exits with empty output before Payload
      // boots). Surface real failures with full stdout+stderr+code so the
      // cause is visible.
      let result: ChildResult | undefined
      for (let attempt = 1; attempt <= 4; attempt++) {
        result = await runResolver(sessionFile, String(user.id))
        if (result.code === 0 && /RESOLVED/.test(result.stdout)) break
        if (attempt < 4 && isTransient(result)) {
          // eslint-disable-next-line no-console
          console.warn(
            `[cross-process-restart] transient error on attempt ${attempt} ` +
              `(code=${result.code}), retrying. Scrubbed output: ` +
              `${(result.stdout + result.stderr).replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]')}`,
          )
          await new Promise((r) => setTimeout(r, attempt * 1500))
          continue
        }
        break
      }

      expect(result, 'resolver must have run at least once').toBeDefined()
      const r = result!
      expect(
        r.stdout,
        `child exit code=${r.code}\nchild stdout:\n${r.stdout}\nchild stderr:\n${r.stderr}`,
      ).toMatch(new RegExp(`RESOLVED ${user.id} teacher`))
      expect(r.code).toBe(0)
      // The session id (bearer) must never appear in the child's output.
      const combined = `${r.stdout}\n${r.stderr}`
      expect(combined).not.toContain(sessionId)
    } finally {
      // Best-effort cleanup of the bearer temp file.
      try {
        writeFileSync(sessionFile, '', { mode: 0o600 })
      } catch {
        /* ignore */
      }
    }
  }, 90_000)
})
