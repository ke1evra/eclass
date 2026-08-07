import { test, expect } from '@playwright/test'

/**
 * ECLASS-8 — RED product acceptance checklist.
 *
 * This spec is the canonical statement of the MVP critical flow. It is
 * EXPECTED TO FAIL until the user-facing features land (P1–P5). It exists
 * now so that:
 *   - the team agrees on what "done MVP" means in machine-checkable form;
 *   - every later task has a target to make a specific step pass;
 *   - CI has a real product gate, not just unit tests.
 *
 * Critical flow (matches ai-context tddWorkflow):
 *   teacher signup → class → invite → student join → assignment →
 *   autosave/reload → idempotent submit → auto+manual review →
 *   feedback → remediation.
 *
 * Flow steps that depend on features built in later epics are skipped with a
 * reference to the task that unblocks them. Steps that ECLASS-8 owns (the
 * product checklist exists and emits the right funnel events) are asserted
 * straight away and are RED today.
 */

test.describe('MVP critical acceptance flow — ECLASS-8', () => {
  test('product checklist page exists and lists the 5 user needs', async ({ page }) => {
    await page.goto('/about/mvp')
    // The 5 canonical needs from src/metrics/contract.ts must be reflected.
    await expect(page.getByRole('heading', { name: /MVP scope/i })).toBeVisible()
    for (const fragment of [
      /актуального экзамена фипи/i,
      /пригласить ученика одной ссылкой/i,
      /выдать конкретную работу/i,
      /сдать работу с телефона без потери/i,
      /объясняющую обратную связь/i,
    ]) {
      await expect(page.locator('body')).toContainText(fragment)
    }
  })

  test('teacher can invite a student and assign work within one session (target ≤ 3 min)', async ({
    page,
  }) => {
    test.skip(true, 'RED — unblocked progressively by ECLASS-13..23')
    // Placeholder for the time-to-first-assignment critical path. Kept here so
    // the checklist is explicit; the assertion body is filled as features land.
    await page.goto('/')
    expect(true).toBe(false)
  })

  test('student submission survives reload and submits idempotently', async () => {
    test.skip(true, 'RED — unblocked by ECLASS-28..31')
  })

  test('teacher can review and send feedback that the student receives', async () => {
    test.skip(true, 'RED — unblocked by ECLASS-33..35')
  })

  test('funnel events activation/completion/feedback are emitted with the contract shape', async () => {
    test.skip(true, 'RED — unblocked by ECLASS-38 (privacy-safe telemetry)')
  })

  test('KPI targets are documented on the MVP page and match the metrics contract', async ({
    page,
  }) => {
    await page.goto('/about/mvp')
    await expect(page.locator('body')).toContainText('≥60%') // teacher activation
    await expect(page.locator('body')).toContainText('≥70%') // student completion
    await expect(page.locator('body')).toContainText('≤24') // feedback SLA (hours)
    await expect(page.locator('body')).toContainText('≥35%') // week-2 retention
  })
})
