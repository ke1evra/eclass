import { NextRequest, NextResponse } from 'next/server'
import type { Payload } from 'payload'
import { resolveActorFromRequest } from '@/auth/route-actor'
import { classStatus, getClassServices } from '@/classes/server'

/**
 * /api/classes/[id]/invites — ECLASS-56 / ECLASS-15.
 *
 * POST → mint a fresh single-use invite for the class (owner only). The code
 * is opaque (no class/teacher identifiers) and expires in 24h. The response
 * carries the code + a join URL the teacher can paste into a chat.
 */
export async function handleCreateInvite(req: NextRequest, payload: Payload, id: string) {
  const actor = await resolveActorFromRequest(payload, req)
  if (!actor) return NextResponse.json({ ok: false, code: 'unauthorized' }, { status: 401 })

  const { inviteService } = getClassServices(payload)
  const result = await inviteService.createInvite(actor, id)
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code }, { status: classStatus(result.code) })
  }
  return NextResponse.json(
    { ok: true, code: result.code, expiresAt: result.expiresAt, joinUrl: `/join?code=${result.code}` },
    { status: 201 },
  )
}
