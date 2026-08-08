import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleConfirm } from './handler'

/**
 * POST /api/auth/confirm — ECLASS-67.
 *
 * Real token-hash flow. Accepts `{ token }` (delivered out-of-band via the
 * email worker); the handler verifies it atomically and flips
 * emailConfirmed. Logic lives in ./handler.ts so the route-boundary test can
 * inject a fault-inducing Payload Proxy (see login/handler.ts for the same
 * pattern).
 *
 * 422 validation_error (no token); 400 invalid_or_expired (wrong/expired/
 * replayed/unknown — collapsed for anti-enumeration); 200 ok; 503 error
 * (infrastructure failure, never masked as invalid).
 */
export async function POST(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleConfirm(req, payload)
}
