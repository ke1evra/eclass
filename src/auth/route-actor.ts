/**
 * Route-boundary actor resolution — ECLASS-56.
 *
 * The single way an API route learns WHO is calling: the opaque
 * `eclass_session` cookie → resolveActor (Sessions row → Users row). Identity
 * in a query string, body, or header is NEVER consulted — handlers receive it
 * pre-resolved so no route can accidentally trust client input.
 */
import type { Payload } from 'payload'
import type { NextRequest } from 'next/server'
import { resolveActor, type Clock } from './payload-resolver'
import type { Actor } from '@/domain/authorization'

export const SESSION_COOKIE = 'eclass_session'

export interface ResolvedActor {
  actor: Actor | null
  /** Resolve the raw cookie value from a NextRequest without extra deps. */
  cookieValue: string | undefined
}

export async function resolveActorFromRequest(
  payload: Payload,
  req: NextRequest,
  clock: Clock = { now: () => Date.now() },
): Promise<Actor | null> {
  const cookieValue =
    req.cookies.get(SESSION_COOKIE)?.value ?? undefined
  return resolveActor(payload, cookieValue, clock)
}
