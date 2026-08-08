import { NextRequest } from 'next/server'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { handleSignup } from './handler'

/**
 * POST /api/auth/signup — ECLASS-67 (v2, outbox).
 *
 * Creates a teacher user WITH the confirmation hash + expiry AND a pending
 * `email-jobs` row in ONE Mongo transaction (rollback on any failure → user
 * is not stranded, no orphaned token, duplicate-email retry is clean). The
 * transport is NOT called here; the worker drains the outbox. Response is
 * `{ ok, userId }` only — the raw token NEVER appears in the body. Logic
 * lives in ./handler.ts (testable seam, same pattern as login/handler.ts).
 */
export async function POST(req: NextRequest) {
  const payload = await getPayload({ config })
  return handleSignup(req, payload)
}
