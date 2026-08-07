/**
 * Submission lifecycle — ECLASS-9.
 *
 * Canonical state machine:
 *
 *   assigned ──start──▶ in_progress ──submit──▶ submitted ──check──▶ checked
 *                                                            ▲           │
 *                                                            └──reopen───┘
 *                                                              (audit)
 *
 * Every transition is a pure function that either returns the next immutable
 * state or throws InvalidTransition. There is NO implicit "auto-forward":
 * the only way to move is through these functions, so forbidden transitions
 * are impossible to reach in production code that imports this module.
 */
import type { Submission, SubmissionStatus } from './entities'

export type { Submission, SubmissionStatus }

export class InvalidTransition extends Error {
  readonly code = 'invalid_transition' as const
  readonly from: SubmissionStatus
  readonly to: SubmissionStatus
  constructor(from: SubmissionStatus, to: SubmissionStatus, message?: string) {
    super(message ?? `invalid transition ${from} → ${to}`)
    this.name = 'InvalidTransition'
    this.from = from
    this.to = to
  }
}

/** Allowed transitions. Keys are current state; values are reachable states. */
const ALLOWED: Record<SubmissionStatus, SubmissionStatus[]> = {
  assigned: ['in_progress'],
  in_progress: ['submitted'],
  submitted: ['checked'],
  checked: ['in_review'],
  in_review: ['checked'],
}

const assertTransition = (current: SubmissionStatus, target: SubmissionStatus): void => {
  if (!ALLOWED[current]?.includes(target)) {
    throw new InvalidTransition(current, target)
  }
}

const bump = (s: Submission, at: number): Submission => ({ ...s, updatedAt: at })

/** A "now" clock injectable for deterministic tests. Default = Date.now. */
export const now = (): number => Date.now()

/** assigned → in_progress. */
export function startSubmission(s: Submission, at: number = now()): Submission {
  assertTransition(s.status, 'in_progress')
  return { ...bump(s, at), status: 'in_progress' }
}

/** in_progress → submitted (finalize). */
export function submitSubmission(s: Submission, at: number = now()): Submission {
  assertTransition(s.status, 'submitted')
  return { ...bump(s, at), status: 'submitted', submittedAt: at }
}

/** submitted → checked. */
export function checkSubmission(s: Submission, at: number = now()): Submission {
  assertTransition(s.status, 'checked')
  return { ...bump(s, at), status: 'checked', checkedAt: at }
}

/**
 * checked → in_review. The ONLY way back from `checked`; requires a reason and
 * an actor — this re-open becomes an audited event (NFR audit, ECLASS-38).
 */
export function reopenSubmissionForReview(
  s: Submission,
  opts: { by: string; reason: string },
  at: number = now(),
): Submission {
  assertTransition(s.status, 'in_review')
  if (!opts.reason.trim()) {
    throw new InvalidTransition(s.status, 'in_review', 'reopen requires a non-empty reason')
  }
  return { ...bump(s, at), status: 'in_review', reopenedBy: opts.by, reopenReason: opts.reason }
}

/** Re-finalize after a re-review: in_review → checked. */
export function finalizeReview(s: Submission, at: number = now()): Submission {
  assertTransition(s.status, 'checked')
  return { ...bump(s, at), status: 'checked', checkedAt: at }
}
