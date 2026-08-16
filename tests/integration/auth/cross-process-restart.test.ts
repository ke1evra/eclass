import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasMongo } from '../_payload'

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
 * CI flakiness handling: on a freshly-booted runner the children intermittently
 * exit early (observed: empty stdout/stderr, exit 13). IMPORTANT: this happens
 * BEFORE the script's own handlers engage — main().catch and the watchdog
 * never print anything for these exits, so the failures are NOT made visible
 * by them; the in-script handlers only cover failures after boot starts.
 * The orchestrator therefore retries classified transient outcomes: a Mongo
 * transient error string, or empty output + nonzero exit (process never ran
 * meaningfully). Anything else fails immediately with full output.
 *
 * SECURITY: the opaque session id (a bearer credential for the test account)
 * lives only in a 0600 temp file, is read by the orchestrator solely for the
 * non-leak assertion, and is removed in finally. Children print only the
 * userId + role.
 *
 * NO PAYLOAD IN THE PARENT: this suite deliberately uses describe.skipIf
 * instead of `integrationSuite` — integrationSuite's beforeAll boots a
 * Payload singleton, which would make the parent a DB-connected process and
 * the "orchestrator" claim false. The parent never loads Payload here.
 *
 * INVOCATION: children run via `node --import tsx <script>` — NOT via npx.
 * The silent empty-output exit-13 failures observed on CI happen before the
 * script's own error handling engages (main().catch / watchdog never print),
 * pointing at the npx resolution layer — a hypothesis, not a proven cause.
 * Removing npx eliminates that layer; whether the failures disappear is
 * observed in CI, not asserted here.
 */
interface ChildResult {
  code: number
  stdout: string
  stderr: string
}

async function runScript(script: string, args: string[], timeoutMs = 30_000): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(process.cwd(), 'scripts', script), ...args],
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

/**
 * Uniform child-runner retry. Cold-runner children can die BEFORE the script's
 * own handlers engage (empty output, exit 13 — tsx/ESM bootstrap); retrying
 * immediately re-enters the same window, so every attempt backs off
 * (attempt*2000ms). NOTE: a previous edit raised loop bounds but left inner
 * `attempt < 3` guards — only 2 real retries ever ran; this helper removes
 * that class of bug entirely.
 */
async function runScriptWithRetry(
  script: string,
  args: string[],
  success: (r: ChildResult) => boolean,
  attempts = 6,
): Promise<ChildResult> {
  let last: ChildResult | undefined
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await runScript(script, args)
    if (success(last)) return last
    if (attempt < attempts && isTransient(last)) {
      logRetry(`${script} ${args[0] ?? ''}`, attempt, last)
      await sleep(attempt * 2000)
      continue
    }
    break
  }
  return last!
}

describe.skipIf(!hasMongo)('ECLASS-65: cross-process restart proof (creator exits, fresh boot resolves)', () => {
  it('a class created by a process that has EXITED is found by a freshly booted process (ECLASS-56/14)', async () => {
    const name = `restart-class-${Date.now()}`

    const created = await runScriptWithRetry(
      'restart-persistence.ts',
      ['class-create', name],
      (r) => r.code === 0 && /CLASS_CREATED/.test(r.stdout),
    )
    expect(created.code, `class-create output:\n${created.stdout}\n${created.stderr}`).toBe(0)
    expect(created.stdout).toMatch(/CLASS_CREATED/)

    const found = await runScriptWithRetry(
      'restart-persistence.ts',
      ['class-find', name],
      (r) => r.code === 0 && /CLASS_FOUND 1/.test(r.stdout),
    )
    expect(
      found.stdout,
      `class-find exit=${found.code}\nstdout:\n${found.stdout}\nstderr:\n${found.stderr}`,
    ).toMatch(/CLASS_FOUND 1/)
  }, 120_000)

  it('ECLASS-57: TWO PROCESSES migrating legacy invites CONCURRENTLY converge; the raw code still joins', async () => {
    // Seed a legacy plaintext row from a process that exits.
    const seeded = await runScriptWithRetry(
      'restart-persistence.ts',
      ['invite-seed-legacy'],
      (r) => r.code === 0 && /LEGACY_SEEDED/.test(r.stdout),
    )
    expect(seeded.code, `seed output:\n${seeded.stdout}\n${seeded.stderr}`).toBe(0)
    const legacyCode = seeded.stdout.match(/LEGACY_SEEDED (\S+) (\S+)/)![1]!

    // Two genuinely separate processes run the migration AT THE SAME TIME.
    const [a, b] = await Promise.all([
      runScriptWithRetry('restart-persistence.ts', ['invite-migrate'], (r) => r.code === 0 && /MIGRATED/.test(r.stdout)),
      runScriptWithRetry('restart-persistence.ts', ['invite-migrate'], (r) => r.code === 0 && /MIGRATED/.test(r.stdout)),
    ])
    for (const [name, r] of [['A', a], ['B', b]] as const) {
      expect(r.code, `migrate ${name}: ${r.stdout}\n${r.stderr}`).toBe(0)
      expect(r.stdout).toMatch(/MIGRATED \d+/)
    }

    // A THIRD fresh process joins with the RAW legacy code — the concurrent
    // migration must not have corrupted or double-hashed the row.
    const joined = await runScriptWithRetry(
      'restart-persistence.ts',
      ['join-legacy', legacyCode],
      (r) => r.code === 0 && /JOIN_LEGACY/.test(r.stdout),
    )
    expect(
      joined.stdout,
      `join exit=${joined.code}\nstdout:\n${joined.stdout}\nstderr:\n${joined.stderr}`,
    ).toMatch(/JOIN_LEGACY ok/)
  }, 180_000)

  it('ECLASS-59 literal cross-process: rate hits burned by an EXITED process limit a fresh process', async () => {
    const key = `e2e-rate-xproc-${Date.now()}`

    // Process A burns the whole window (5/5), then exits.
    const burned = await runScriptWithRetry(
      'restart-persistence.ts',
      ['rate-hit', key, '5'],
      (r) => r.code === 0 && /RATE_HIT_DONE/.test(r.stdout),
    )
    expect(burned.code, `rate-hit output:\n${burned.stdout}\n${burned.stderr}`).toBe(0)
    expect(burned.stdout).toMatch(/RATE_HIT_DONE true/)

    // Process B — a genuinely fresh process — must see the SAME window: denied.
    const checked = await runScriptWithRetry(
      'restart-persistence.ts',
      ['rate-check', key],
      (r) => r.code === 0 && /RATE_CHECK/.test(r.stdout),
    )
    expect(
      checked.stdout,
      `rate-check exit=${checked.code}\nstdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`,
    ).toMatch(/RATE_CHECK denied/)
  }, 120_000)

  it('a session created by a process that has EXITED resolves in a freshly booted process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eclass-restart-'))
    const sessionFile = join(dir, 'session')

    try {
      // ---- STEP 1: seed in child process A; A exits before B starts. ----
      // The orchestrator (this test) never touches the DB, so when STEP 2
      // begins the only process that ever wrote the session is verifiably dead.
      const s = await runScriptWithRetry(
        'restart-seed.ts',
        [dir],
        (r) => r.code === 0 && /^SEEDED \S+$/m.test(r.stdout),
      )
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
