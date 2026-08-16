import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { integrationSuite } from '../_payload'

/**
 * ECLASS-65 — GENUINE cross-process restart proof.
 *
 * What distinguishes this from the earlier (rejected) version: the vitest
 * process is a PURE ORCHESTRATOR — it never boots Payload and never writes to
 * the DB. The session is created by child process A (`restart-seed.ts`), which
 * then EXITS. Only after A's exit code has been observed does child process B
 * (`restart-resolve.ts`) boot a fresh Payload against the same MongoDB and
 * resolve the actor. When B succeeds, the creating process is verifiably dead
 * — so the session demonstrably lives in the database, not in any surviving
 * process's memory. That is the restart invariant of the ECLASS-65 exit gate.
 *
 * The previous vitest version kept the creating process (the test runner's
 * Payload singleton) alive while the child resolved — which only proved
 * two-process visibility of one Mongo, not survival of the creator stopping.
 *
 * CI flakiness handling: `npx tsx` cold start on a freshly-booted runner
 * intermittently exits early (observed: empty stdout/stderr, exit 13 — Node's
 * "Unfinished Top-Level Await" when Payload boot never settles). The scripts
 * now make such failures VISIBLE (stderr + watchdog, see restart-seed.ts).
 * The orchestrator retries only classified transient outcomes: a Mongo
 * transient error string, or empty output + nonzero exit (process never ran
 * meaningfully). Anything else fails immediately with full output.
 *
 * SECURITY: the opaque session id (a bearer credential for the test account)
 * lives only in a 0600 temp file, is read by the orchestrator solely for the
 * non-leak assertion, and is removed in finally. Children print only the
 * userId + role.
 */
interface ChildResult {
  code: number
  stdout: string
  stderr: string
}

async function runScript(script: string, args: string[], timeoutMs = 30_000): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', `scripts/${script}`, ...args], {
      env: { ...process.env },
      cwd: process.cwd(),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n[orchestrator] ${script} timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Transient = classified Mongo error, or the process never ran (empty output). */
const isTransient = (r: ChildResult): boolean => {
  const combined = `${r.stdout}\n${r.stderr}`
  if (
    /E11000|WriteConflict|TransientTransaction|catalog changes|IX lock|connection refused|topology|server selection/i.test(
      combined,
    )
  ) {
    return true
  }
  return r.code !== 0 && r.stdout.trim() === '' && r.stderr.trim() === ''
}

const logRetry = (phase: string, attempt: number, r: ChildResult): void => {
  // eslint-disable-next-line no-console
  console.warn(
    `[cross-process-restart] ${phase} transient failure on attempt ${attempt} (code=${r.code}). ` +
      `Scrubbed output: ${(r.stdout + r.stderr).replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]')}`,
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

integrationSuite('ECLASS-65: cross-process restart proof (creator exits, fresh boot resolves)', () => {
  it('a session created by a process that has EXITED resolves in a freshly booted process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eclass-restart-'))
    const sessionFile = join(dir, 'session')

    try {
      // ---- STEP 1: seed in child process A; A exits before B starts. ----
      // The orchestrator (this test) never touches the DB, so when STEP 2
      // begins the only process that ever wrote the session is verifiably dead.
      let seed: ChildResult | undefined
      for (let attempt = 1; attempt <= 3; attempt++) {
        seed = await runScript('restart-seed.ts', [dir])
        if (seed.code === 0 && /^SEEDED \S+$/m.test(seed.stdout)) break
        if (attempt < 3 && isTransient(seed)) {
          logRetry('seed', attempt, seed)
          await sleep(attempt * 1500)
          continue
        }
        break
      }
      expect(seed, 'seed must have run at least once').toBeDefined()
      const s = seed!
      expect(
        s.code,
        `seed exit=${s.code}\nseed stdout:\n${s.stdout}\nseed stderr:\n${s.stderr}`,
      ).toBe(0)
      const userId = s.stdout.match(/^SEEDED (\S+)$/m)?.[1]
      expect(userId, `seed stdout must contain SEEDED <userId>, got:\n${s.stdout}`).toBeTypeOf(
        'string',
      )
      // A has exited with code 0 — the creating process is gone.

      // Read the bearer only for the non-leak assertion below; never log it.
      const sessionId = readFileSync(sessionFile, 'utf-8').trim()
      expect(sessionId.length).toBeGreaterThan(10)

      // ---- STEP 2: resolve in child process B (fresh boot, same Mongo). ----
      let res: ChildResult | undefined
      for (let attempt = 1; attempt <= 4; attempt++) {
        res = await runScript('restart-resolve.ts', [sessionFile, String(userId)])
        if (res.code === 0 && /RESOLVED/.test(res.stdout)) break
        if (attempt < 4 && isTransient(res)) {
          logRetry('resolve', attempt, res)
          await sleep(attempt * 1500)
          continue
        }
        break
      }
      expect(res, 'resolver must have run at least once').toBeDefined()
      const r = res!
      expect(
        r.stdout,
        `resolve exit=${r.code}\nresolve stdout:\n${r.stdout}\nresolve stderr:\n${r.stderr}`,
      ).toMatch(new RegExp(`RESOLVED ${userId} teacher`))
      expect(r.code).toBe(0)

      // The bearer session id must never appear in either child's output.
      const seedOut = `${s.stdout}\n${s.stderr}`
      const resolveOut = `${r.stdout}\n${r.stderr}`
      expect(seedOut).not.toContain(sessionId)
      expect(resolveOut).not.toContain(sessionId)
    } finally {
      // Best-effort removal of the bearer temp file and its directory.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }, 180_000)
})
