/**
 * In-memory API router — ECLASS-10.
 *
 * This is the seam between the wire contract (`contracts.ts`) and the domain
 * (`domain/*`). It exists so the critical slice is exercisable end-to-end
 * without HTTP or a database. Next.js route handlers in `src/app/api/*` will
 * delegate to these functions; they are deliberately framework-agnostic.
 *
 * Responsibilities:
 *   - parse + validate input with the contract schema;
 *   - enforce authorization via the domain policy;
 *   - drive the domain lifecycle;
 *   - return a typed `{ status, body }` shape (200 data | ProblemDetails).
 */
import {
  CreateAssignmentRequest,
  CreateClassRequest,
  ReviewRequest,
  SubmitRequest,
  UpsertAnswerRequest,
} from './contracts'
import {
  authorize,
  toHttpStatus,
  type Actor,
  type Decision,
} from '@/domain/authorization'
import {
  checkSubmission,
  submitSubmission,
  type Submission,
} from '@/domain/lifecycle'

export interface ApiResponse {
  status: number
  body: Record<string, unknown>
}

const ok = (body: Record<string, unknown>): ApiResponse => ({ status: 200, body })
const problem = (
  code: string,
  title: string,
  status: number,
  extra: Record<string, unknown> = {},
): ApiResponse => ({ status, body: { code, title, status, ...extra } })

const fromDecision = (d: Decision): ApiResponse =>
  d.allowed ? ok({}) : problem(d.code, d.code === 'not_found' ? 'Not Found' : 'Forbidden', toHttpStatus(d))

/** Create a class. Owner is the calling teacher. */
export async function handleCreateClass(
  raw: unknown,
  actor: Actor,
): Promise<ApiResponse> {
  const parsed = CreateClassRequest.safeParse(raw)
  if (!parsed.success) {
    return problem('validation_error', 'Validation failed', 422, {
      errors: parsed.error.flatten().fieldErrors,
    })
  }
  const req = parsed.data
  // Creating a class is always allowed for an authenticated teacher; the
  // resource is new and owned by them by construction.
  const decision = authorize(actor, 'create', { ownerId: actor.id })
  if (!decision.allowed) return fromDecision(decision)

  return ok({
    id: `cls-${Math.random().toString(36).slice(2, 10)}`,
    name: req.name,
    subjectVersionId: req.subjectVersionId,
    inviteCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
    createdAt: new Date().toISOString(),
  })
}

/** Submit a submission idempotently. */
export async function handleSubmit(
  submission: Submission,
  raw: unknown,
  actor: Actor,
): Promise<ApiResponse> {
  const parsed = SubmitRequest.safeParse(raw)
  if (!parsed.success) {
    return problem('validation_error', 'Validation failed', 422, {
      errors: parsed.error.flatten().fieldErrors,
    })
  }
  const decision = authorize(actor, 'submit', submission)
  if (!decision.allowed) return fromDecision(decision)

  // Idempotency: a finalized submission for this key returns the same result
  // instead of re-transitioning. (Full idempotency store lands in ECLASS-30.)
  if (submission.status === 'submitted' || submission.status === 'checked') {
    return ok({ id: submission.id, status: submission.status, submittedAt: null, checkedAt: null })
  }

  try {
    const next = submitSubmission(submission)
    return ok({
      id: next.id,
      assignmentId: next.assignmentId,
      status: next.status,
      submittedAt: new Date(next.submittedAt ?? Date.now()).toISOString(),
      checkedAt: null,
    })
  } catch {
    return problem('invalid_transition', 'Invalid transition', 409)
  }
}

/** Review a submission; total score is derived server-side. */
export async function handleReview(
  submission: Submission,
  raw: unknown,
  actor: Actor,
): Promise<ApiResponse> {
  const parsed = ReviewRequest.safeParse(raw)
  if (!parsed.success) {
    return problem('validation_error', 'Validation failed', 422, {
      errors: parsed.error.flatten().fieldErrors,
    })
  }
  const req = parsed.data
  const decision = authorize(actor, 'review', submission)
  if (!decision.allowed) return fromDecision(decision)

  // Total is ALWAYS derived; client cannot supply it.
  const totalScore = req.criterionScores.reduce((sum, c) => sum + c.score, 0)
  const maxScore = Math.max(totalScore, 1) * 1 // placeholder; rubric snapshot in ECLASS-34

  let status = 'draft'
  let checkedAt: string | null = null
  if (req.finalize) {
    try {
      checkSubmission(submission)
      status = 'finalized'
      checkedAt = new Date().toISOString()
    } catch {
      return problem('invalid_transition', 'Cannot finalize in current state', 409)
    }
  }

  return ok({
    id: `rev-${Math.random().toString(36).slice(2, 10)}`,
    submissionId: submission.id,
    reviewerId: actor.id,
    status,
    totalScore,
    maxScore,
    finalizedAt: checkedAt,
  })
}

/** Upsert an answer (autosave). Validates then delegates to the store (later). */
export async function handleUpsertAnswer(
  raw: unknown,
  _actor: Actor,
): Promise<ApiResponse> {
  const parsed = UpsertAnswerRequest.safeParse(raw)
  if (!parsed.success) {
    return problem('validation_error', 'Validation failed', 422, {
      errors: parsed.error.flatten().fieldErrors,
    })
  }
  // Stub: real dedup store + audit in ECLASS-30.
  return ok({
    answerId: `ans-${Math.random().toString(36).slice(2, 10)}`,
    savedAt: new Date().toISOString(),
    deduped: false,
  })
}

/** Create an assignment. Validates recipients are explicit. */
export async function handleCreateAssignment(
  raw: unknown,
  actor: Actor,
): Promise<ApiResponse> {
  const parsed = CreateAssignmentRequest.safeParse(raw)
  if (!parsed.success) {
    return problem('validation_error', 'Validation failed', 422, {
      errors: parsed.error.flatten().fieldErrors,
    })
  }
  const req = parsed.data
  const decision = authorize(actor, 'create', { ownerId: actor.id, classId: req.classId })
  if (!decision.allowed) return fromDecision(decision)

  return ok({
    id: `asg-${Math.random().toString(36).slice(2, 10)}`,
    classId: req.classId,
    title: req.title,
    questionVersionIds: req.questionVersionIds,
    recipientIds: req.recipientIds,
    dueAt: req.dueAt ?? null,
    createdAt: new Date().toISOString(),
  })
}
