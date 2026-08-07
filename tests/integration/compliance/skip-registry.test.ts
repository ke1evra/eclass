import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CI self-test: unregistered test.skip / test.todo are forbidden — ECLASS-60.
 *
 * The independent review found that masked a bug with a test that asserted
 * an isolated policy function while the real path returned ok. The acceptance
 * suite had four `test.skip` calls that were effectively dead. This test makes
 * every skip/todo carry an explicit registration: a comment marker
 * `GATED BY: ECLASS-N` immediately above the skip, AND an entry in the
 * ALLOWED_SKIPS registry. An unregistered skip fails the build.
 *
 * This is the gate that stops me (or anyone) from hiding a failing/missing
 * test behind a skip without naming the unblocking task.
 */

const ACCEPTANCE_DIR = resolve(__dirname, '../../../tests/acceptance')

/** Registered skips: specFile basename → list of allowed skip reasons. */
const ALLOWED_SKIPS: Record<string, string[]> = {
  'critical-flow.spec.ts': [
    'GATED BY ECLASS-15 (invite) + ECLASS-23 (assignment builder)',
    'GATED BY ECLASS-28..31 (autosave + idempotent submit)',
    'GATED BY ECLASS-33..35 (review + feedback)',
    'GATED BY ECLASS-38 (telemetry)',
  ],
}

const listSpecFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listSpecFiles(full))
    else if (entry.endsWith('.spec.ts') || entry.endsWith('.spec.js')) out.push(full)
  }
  return out
}

interface SkipOccurrence {
  file: string
  line: number
  /** The second argument to test.skip / test.todo, if any. */
  reason: string
}

/**
 * Find the matching closing paren for the open paren at `start`, respecting
 * nested parens and string/template literals. Returns the index AFTER the
 * closing paren, or -1 if unbalanced.
 */
const findCallEnd = (src: string, openParen: number): number => {
  let depth = 0
  let i = openParen
  let inStr: string | null = null
  while (i < src.length) {
    const ch = src[i]
    if (inStr) {
      if (ch === inStr && src[i - 1] !== '\\') inStr = null
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
    } else if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

const scanForSkips = (files: string[]): SkipOccurrence[] => {
  const found: SkipOccurrence[] = []
  // Match any `<id>.skip(` or `<id>.todo(` — catches `test.skip`, `_t.skip`,
  // `describe.skip`, imported aliases. Anything that suppresses a test counts.
  const startRe = /\w+\.(skip|todo)\s*\(/g
  // Strip line comments and block comments so a docstring mentioning
  // `test.skip` does not count as a real skip call.
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^\s*\/\/.*$/gm, '')
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'))
    let sm: RegExpExecArray | null
    while ((sm = startRe.exec(src)) !== null) {
      const openParen = sm.index + sm[0].length - 1
      const end = findCallEnd(src, openParen)
      if (end < 0) continue
      const args = src.slice(openParen + 1, end - 1)
      const line = src.slice(0, sm.index).split('\n').length
      const strRe = /(['"`])([^'"`\n]*)\1/g
      let si: RegExpExecArray | null
      while ((si = strRe.exec(args)) !== null) {
        const reason = si[2] ?? ''
        if (!reason) continue
        found.push({ file, line, reason })
      }
    }
  }
  return found
}

describe('ECLASS-60: skip/todo registry (CI self-test)', () => {
  it('every test.skip / test.todo in acceptance is registered', () => {
    const files = listSpecFiles(ACCEPTANCE_DIR)
    const skips = scanForSkips(files)

    const violations: string[] = []
    for (const s of skips) {
      const basename = s.file.split('/').pop() ?? ''
      const allowed = ALLOWED_SKIPS[basename] ?? []
      if (!allowed.includes(s.reason)) {
        violations.push(`${basename}:${s.line} — unregistered skip "${s.reason}"`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('the registry documents the unblocking task for every registered skip', () => {
    // Every registered reason MUST name an ECLASS-N task that unblocks it.
    for (const [file, reasons] of Object.entries(ALLOWED_SKIPS)) {
      for (const reason of reasons) {
        expect(reason, `${file} skip without unblocking task`).toMatch(/ECLASS-\d+/)
      }
    }
  })

  it('no acceptance spec file exists without being covered by the registry if it has skips', () => {
    // Sanity: if a new spec file introduces skips, the registry must grow.
    const files = listSpecFiles(ACCEPTANCE_DIR)
    const skips = scanForSkips(files)
    const filesWithSkips = new Set(skips.map((s) => s.file.split('/').pop() ?? ''))
    for (const f of filesWithSkips) {
      expect(ALLOWED_SKIPS, `untracked spec with skips: ${f}`).toHaveProperty(f)
    }
  })
})
