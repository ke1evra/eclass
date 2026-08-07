import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * Vitest — unit + integration layer of the test pyramid.
 * E2E (acceptance) lives under tests/acceptance and is driven by Playwright.
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
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/payload.config.ts'],
    },
  },
})
