import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * Vitest — unit + integration layer of the test pyramid (ECLASS-11).
 * E2E (acceptance) lives under tests/acceptance and is driven by Playwright.
 *
 * Coverage thresholds guard the CRITICAL domain branches: lifecycle transitions
 * and authorization decisions. A drop below these numbers fails CI — this is
 * the "test pyramid" gate, not a vanity metric.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/domain/**/*.ts', 'src/api/**/*.ts', 'src/metrics/**/*.ts', 'src/auth/service.ts', 'src/auth/session.ts', 'src/classes/**/*.ts', 'src/students/service.ts', 'src/security/**/*.ts', 'src/content/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/payload.config.ts', 'src/**/server.ts', 'src/app/**'],
      thresholds: {
        // Critical branches: every lifecycle transition and authorization
        // decision MUST be exercised. Lines/branches are high because the
        // domain is small and pure — there is no excuse for a gap.
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
})
