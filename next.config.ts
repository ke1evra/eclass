import type { NextConfig } from 'next'

/**
 * PWA-first Next.js config for Экзамен Класс.
 *
 * Notes:
 * - We keep this intentionally minimal in P0. Image optimization, headers,
 *   service-worker runtime and CSP are introduced with their own TDD tasks
 *   (ECLASS-27, ECLASS-39). Do NOT add speculative config here.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    typedRoutes: true,
  },
}

export default nextConfig
