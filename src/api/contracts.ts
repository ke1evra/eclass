/**
 * API contracts — ECLASS-10 (TDD-P0-03).
 *
 * The contract layer is the single source of truth for the wire shape of the
 * critical vertical slice. It has three jobs:
 *
 *   1. Type the request/response of every endpoint so front and back can be
 *      built in parallel against the same shape.
 *   2. Validate at the edge with zod schemas — invalid input never reaches the
 *      domain.
 *   3. Carry the error model (Problem Details for HTTP APIs, RFC 9457) so
 *      consumers can branch on a stable type/code rather than a string.
 *
 * Privacy invariant (acceptance): responses never include `email` or answer
 * payloads outside the permitted context. The contract enforces this by
 * construction — there is no field for them on the response shapes.
 */
import { z } from 'zod'

/* -------------------------------------------------------------------------- */
/* Error model — RFC 9457 Problem Details                                     */
/* -------------------------------------------------------------------------- */

export type ErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'invalid_transition'
  | 'rate_limited'
  | 'payload_too_large'

export const ProblemDetails = z.object({
  type: z.string().url().default('about:blank'),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: z.string(),
  detail: z.string().optional(),
  /** Field-level validation errors, keyed by json path. */
  errors: z.record(z.string(), z.string()).optional(),
  /** Stable request id for audit/support correlation. */
  requestId: z.string().optional(),
})
export type ProblemDetails = z.infer<typeof ProblemDetails>

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                          */
/* -------------------------------------------------------------------------- */

export const Id = z.string().min(1)
export const IsoDate = z.string().datetime()
export const IdempotencyKey = z.string().min(8).max(128)

/** Cursor pagination — opaque cursor, no offset leaking. */
export const PageQuery = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})
export type PageQuery = z.infer<typeof PageQuery>

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    totalEstimate: z.number().int().nonnegative().optional(),
  })
}

/* -------------------------------------------------------------------------- */
/* 1. Classes                                                                 */
/* -------------------------------------------------------------------------- */

export const CreateClassRequest = z.object({
  name: z.string().min(1).max(120),
  subjectVersionId: Id,
})
export type CreateClassRequest = z.infer<typeof CreateClassRequest>

export const ClassResponse = z.object({
  id: Id,
  name: z.string(),
  subjectVersionId: Id,
  /** Opaque join handle. NEVER the teacher's email. */
  inviteCode: z.string().optional(),
  createdAt: IsoDate,
})
export type ClassResponse = z.infer<typeof ClassResponse>

/* -------------------------------------------------------------------------- */
/* 2. Invite / join                                                           */
/* -------------------------------------------------------------------------- */

export const JoinClassRequest = z.object({
  inviteCode: z.string().min(1).max(64),
  /** Optional display name shown inside the class. Not required for MVP. */
  displayName: z.string().max(120).optional(),
})
export type JoinClassRequest = z.infer<typeof JoinClassRequest>

export const JoinClassResponse = z.object({
  classId: Id,
  studentId: Id,
})
export type JoinClassResponse = z.infer<typeof JoinClassResponse>

/* -------------------------------------------------------------------------- */
/* 3. Content listing (versioned question bank)                               */
/* -------------------------------------------------------------------------- */

export const QuestionType = z.enum([
  'single-choice',
  'multiple-choice',
  'short-text',
  'extended-text',
])

export const QuestionSummary = z.object({
  id: Id,
  type: QuestionType,
  subjectVersionId: Id,
  /** Stable ФИПИ code, never free text. */
  code: z.string(),
})
export type QuestionSummary = z.infer<typeof QuestionSummary>

export const ListContentQuery = PageQuery.extend({
  subjectVersionId: Id,
  type: QuestionType.optional(),
  /** Text search is server-side; no client-side regex injection. */
  q: z.string().max(200).optional(),
})
export type ListContentQuery = z.infer<typeof ListContentQuery>

export const ListContentResponse = paginated(QuestionSummary)
export type ListContentResponse = z.infer<typeof ListContentResponse>

/* -------------------------------------------------------------------------- */
/* 4. Assignments                                                             */
/* -------------------------------------------------------------------------- */

export const CreateAssignmentRequest = z.object({
  classId: Id,
  title: z.string().min(1).max(200),
  questionVersionIds: z.array(Id).min(1),
  /** Explicit recipients — no implicit "everyone" (security default). */
  recipientIds: z.array(Id).min(1),
  dueAt: IsoDate.optional(),
})
export type CreateAssignmentRequest = z.infer<typeof CreateAssignmentRequest>

export const AssignmentResponse = z.object({
  id: Id,
  classId: Id,
  title: z.string(),
  questionVersionIds: z.array(Id),
  recipientIds: z.array(Id),
  dueAt: IsoDate.nullable(),
  createdAt: IsoDate,
})
export type AssignmentResponse = z.infer<typeof AssignmentResponse>

/* -------------------------------------------------------------------------- */
/* 5. Answers (autosave)                                                      */
/* -------------------------------------------------------------------------- */

export const UpsertAnswerRequest = z.object({
  questionVersionId: Id,
  /**
   * Idempotency key supplied by the client so a retried autosave is a no-op,
   * not a duplicate (NFR: reliable submit, ECLASS-30).
   */
  idempotencyKey: IdempotencyKey,
  payload: z.unknown(),
})
export type UpsertAnswerRequest = z.infer<typeof UpsertAnswerRequest>

export const UpsertAnswerResponse = z.object({
  answerId: Id,
  savedAt: IsoDate,
  /** True when this call produced no change (deduped by idempotencyKey). */
  deduped: z.boolean(),
})
export type UpsertAnswerResponse = z.infer<typeof UpsertAnswerResponse>

/* -------------------------------------------------------------------------- */
/* 6. Submit                                                                  */
/* -------------------------------------------------------------------------- */

export const SubmitRequest = z.object({
  /** Idempotency: a retried submit returns the same finalized submission. */
  idempotencyKey: IdempotencyKey,
})
export type SubmitRequest = z.infer<typeof SubmitRequest>

export const SubmissionResponse = z.object({
  id: Id,
  assignmentId: Id,
  status: z.enum(['assigned', 'in_progress', 'submitted', 'checked', 'in_review']),
  submittedAt: IsoDate.nullable(),
  checkedAt: IsoDate.nullable(),
})
export type SubmissionResponse = z.infer<typeof SubmissionResponse>

/* -------------------------------------------------------------------------- */
/* 7. Review                                                                  */
/* -------------------------------------------------------------------------- */

export const ReviewRequest = z.object({
  /** Per-criterion scores; total is derived, never client-supplied. */
  criterionScores: z.array(
    z.object({
      rubricCriterionId: Id,
      score: z.number().min(0),
      note: z.string().max(2000).optional(),
    }),
  ),
  finalize: z.boolean().default(false),
})
export type ReviewRequest = z.infer<typeof ReviewRequest>

export const ReviewResponse = z.object({
  id: Id,
  submissionId: Id,
  reviewerId: Id,
  status: z.enum(['draft', 'finalized']),
  totalScore: z.number(),
  maxScore: z.number(),
  finalizedAt: IsoDate.nullable(),
})
export type ReviewResponse = z.infer<typeof ReviewResponse>

/* -------------------------------------------------------------------------- */
/* 8. Feedback thread                                                         */
/* -------------------------------------------------------------------------- */

export const CreateCommentRequest = z.object({
  body: z.string().min(1).max(4000),
  /** `internal` notes are server-enforced hidden from students. */
  visibility: z.enum(['public', 'internal']).default('public'),
})
export type CreateCommentRequest = z.infer<typeof CreateCommentRequest>

export const CommentResponse = z.object({
  id: Id,
  submissionId: Id,
  authorRole: z.enum(['teacher', 'student', 'admin']),
  visibility: z.enum(['public', 'internal']),
  body: z.string(),
  createdAt: IsoDate,
})
export type CommentResponse = z.infer<typeof CommentResponse>

export const ListFeedbackResponse = paginated(CommentResponse)
export type ListFeedbackResponse = z.infer<typeof ListFeedbackResponse>

/* -------------------------------------------------------------------------- */
/* Audit event — emitted by mutating endpoints (consumed in ECLASS-38)        */
/* -------------------------------------------------------------------------- */

export const AuditEvent = z.object({
  type: z.string(),
  actorId: Id,
  resourceType: z.string(),
  resourceId: Id,
  at: IsoDate,
  /** NEVER carries email, name, or answer text (NFR privacy). */
})
export type AuditEvent = z.infer<typeof AuditEvent>

/* -------------------------------------------------------------------------- */
/* Endpoint registry — the machine-checkable contract surface                */
/* -------------------------------------------------------------------------- */

export interface EndpointContract<
  TRequest extends z.ZodTypeAny,
  TResponse extends z.ZodTypeAny,
> {
  method: 'POST' | 'GET' | 'PATCH' | 'DELETE'
  path: string
  request: TRequest
  response: TResponse
  /** Problem codes this endpoint can legitimately return. */
  errors: readonly ErrorCode[]
}

export const CONTRACTS = {
  createClass: {
    method: 'POST',
    path: '/api/classes',
    request: CreateClassRequest,
    response: ClassResponse,
    errors: ['validation_error', 'forbidden'],
  },
  joinClass: {
    method: 'POST',
    path: '/api/classes/join',
    request: JoinClassRequest,
    response: JoinClassResponse,
    errors: ['validation_error', 'not_found', 'conflict'],
  },
  listContent: {
    method: 'GET',
    path: '/api/content',
    request: ListContentQuery,
    response: ListContentResponse,
    errors: ['validation_error', 'forbidden'],
  },
  createAssignment: {
    method: 'POST',
    path: '/api/assignments',
    request: CreateAssignmentRequest,
    response: AssignmentResponse,
    errors: ['validation_error', 'forbidden', 'not_found'],
  },
  upsertAnswer: {
    method: 'POST',
    path: '/api/answers',
    request: UpsertAnswerRequest,
    response: UpsertAnswerResponse,
    errors: ['validation_error', 'forbidden', 'not_found', 'conflict'],
  },
  submit: {
    method: 'POST',
    path: '/api/submissions/:id/submit',
    request: SubmitRequest,
    response: SubmissionResponse,
    errors: ['forbidden', 'not_found', 'conflict', 'invalid_transition'],
  },
  review: {
    method: 'POST',
    path: '/api/submissions/:id/review',
    request: ReviewRequest,
    response: ReviewResponse,
    errors: ['forbidden', 'not_found', 'conflict', 'validation_error'],
  },
  createComment: {
    method: 'POST',
    path: '/api/submissions/:id/comments',
    request: CreateCommentRequest,
    response: CommentResponse,
    errors: ['forbidden', 'not_found', 'validation_error'],
  },
} as const satisfies Record<string, EndpointContract<z.ZodTypeAny, z.ZodTypeAny>>

export type ContractName = keyof typeof CONTRACTS
