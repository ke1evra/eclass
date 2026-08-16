import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'

/**
 * GET /api/me — ECLASS-56. Cheap session probe for pages and E2E: returns the
 * resolved actor (or anonymous). No email, no ids beyond the caller's own.
 */
export async function handleMe(req: NextRequest, payload: Payload) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ authenticated: false })
  return NextResponse.json({ authenticated: true, role: actor.role, userId: actor.id })
}
