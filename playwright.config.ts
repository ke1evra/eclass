import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config — acceptance / E2E layer.
 *
 * The acceptance suite is the failing product checklist for ECLASS-8: it
 * asserts the critical teacher→student→feedback flow exists and emits the
 * activation/completion/feedback telemetry events. There is no app yet, so
 * every spec here is RED by design. The webServer block is wired so the same
 * suite turns GREEN automatically once the app boots.
 */
const PORT = Number(process.env.PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests/acceptance',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: process.env.CI ? 'npm run start' : 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
