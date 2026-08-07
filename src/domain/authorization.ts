/**
 * Authorization policy layer — ECLASS-9.
 *
 * Server-side, pure, framework-agnostic. Every read and mutation goes through
 * `authorize()`. The result distinguishes two denial codes:
 *
 *   - `not_found`  → existence must not leak. This is what a cross-tenant
 *                    caller sees for ANY resource they don't own (404 at the
 *                    edge). This is deliberate: returning `forbidden` would
 *                    confirm the resource exists.
 *   - `forbidden`  → the caller is authenticated and the resource is
 *                    legitimately visible, but the action is not permitted
 *                    for their role (e.g. a student creating an assignment).
 *
 * Resource shape contract: a resource is any object that exposes either
 * `ownerId` (teacher-owned) or `studentId` (student-owned). The policy never
 * trusts client input beyond the actor identity.
 */
import type { Role, User } from './entities'

export type Action = 'read' | 'create' | 'update' | 'delete' | 'submit' | 'review'

export interface Actor {
  id: string
  role: Role
}

/** Minimum structural contract a resource must satisfy for the policy. */
export interface OwnedResource {
  ownerId?: string
  studentId?: string
  classId?: string
}

// Re-export entity types used by callers (single import surface).
export type { User, Role, ClassEntity, Assignment, Submission, Review, Comment } from './entities'

export type Decision =
  | { allowed: true }
  | { allowed: false; code: 'not_found' | 'forbidden' }

const allow = (): Decision => ({ allowed: true })
const deny = (code: 'not_found' | 'forbidden'): Decision => ({ allowed: false, code })

/**
 * Core authorization entry point. `actor` is the authenticated principal;
 * `action` is what they intend; `resource` is the target (or the candidate
 * shape for `create`).
 */
export function authorize(
  actor: Actor,
  action: Action,
  resource: OwnedResource,
): Decision {
  // Admins: read-only support access. Mutating production data must go through
  // an audited path, so we deny mutations here (ECLASS-38 audit).
  if (actor.role === 'admin') {
    return action === 'read' ? allow() : deny('forbidden')
  }

  // Teachers act within their own tenant: ownership of the class chain.
  if (actor.role === 'teacher') {
    if (resource.ownerId === actor.id) return allow()
    // Not the owner → existence must not leak (404).
    return deny('not_found')
  }

  // Students: restricted action set + strict self-only access.
  if (actor.role === 'student') {
    // Students may only create submissions (the act of submitting work) — and
    // only on resources that will carry their studentId. Everything else is
    // a role mismatch → forbidden.
    const studentActions: Action[] = ['read', 'submit']
    if (!studentActions.includes(action)) return deny('forbidden')

    // For submit/read, the resource must belong to THIS student.
    if (resource.studentId === actor.id) return allow()
    // Another student's resource → not_found (no existence leak).
    return deny('not_found')
  }

  return deny('forbidden')
}

/**
 * Maps a policy decision to an HTTP status for edge handlers. Centralized so
 * the rule "denials never distinguish not-found from forbidden at the wire
 * for cross-tenant callers" lives in one place.
 *
 * Note: both 404 and 403 are returned as-is for *in-tenant* denials; the
 * caller already knows the resource exists. For cross-tenant lookups the
 * repository layer should treat `not_found` as a hard 404 regardless.
 */
export function toHttpStatus(decision: Decision): number {
  if (decision.allowed) return 200
  return decision.code === 'not_found' ? 404 : 403
}
