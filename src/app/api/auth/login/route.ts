import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleLogin } from './handler'

/**
 * POST /api/auth/login — ECLASS-56 / ECLASS-65.
 *
 * Verifies credentials via Payload (ADR-0007), creates one opaque session,
 * sets the eclass_session cookie. The response body contains ONLY { ok, userId }
 * — never the password hash, never the Payload JWT, never the session token
 * (the token goes exclusively into the httpOnly cookie). Logic lives in
 * ./handler.ts (see note there on why it is split out).
 */
export async function POST(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleLogin(req, payload)
}
