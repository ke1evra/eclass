import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/**
 * Accessibility gate — CB-6 (ECLASS-53).
 *
 * The E2E gate must actually check the product; an a11y gate was missing. This
 * suite runs axe-core against the critical pages and fails the build on any
 * serious (serious/critical) violation. It targets WCAG 2.2 AA — the project
 * NFR ("ключевые сценарии соответствуют WCAG 2.2 AA").
 *
 * Tags: best-practice catches structural issues; wcag2a/wcag2aa are the
 * canonical rules. We fail on serious+critical only; minor/moderate are
 * reported but tracked separately so a real product can ship while improving.
 */
const PAGES = ['/', '/about/mvp', '/student']

for (const path of PAGES) {
  test(`${path} has no serious/critical a11y violations`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'best-practice'])
      .analyze()

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([])
  })
}
