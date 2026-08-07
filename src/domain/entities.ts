/**
 * Domain entities — ECLASS-9 (TDD-P0-02).
 *
 * Pure TypeScript types describing the core of the platform. No ORM, no
 * framework: every collection in Payload will eventually mirror these shapes,
 * but the domain stays independent so it can be unit-tested without a DB.
 *
 * Ownership rules:
 *   - Every mutable resource has an `ownerId` (the teacher who created it).
 *   - Students are scoped via `studentId` on the resources they produce.
 *   - `SubjectVersionId` ties content to a versioned ФИПИ year (ECLASS-18).
 */

/** Roles are the only authorization primitive; RBAC + ownership. */
export type Role = 'teacher' | 'student' | 'admin'

export interface User {
  id: string
  role: Role
  /** Display name shown inside the tenant; never used as an identifier. */
  displayName?: string
}

/**
 * A class is the top-level tenant boundary for a teacher. Nothing crosses
 * between classes. `inviteCode` is the canonical join handle (ECLASS-15).
 */
export interface ClassEntity {
  id: string
  ownerId: string
  subjectVersionId: string
  name: string
  inviteCode?: string
  createdAt?: number
}

export interface Student {
  id: string
  classId: string
  /** Hashed/derived handle — never the raw email in domain logs (NFR privacy). */
  displayName?: string
}

/**
 * An assignment is the teacher's intent: "this work should be done by these
 * students before this deadline." `recipientIds` is explicit — no implicit
 * "everyone" so leaks are impossible by default (ECLASS-24).
 */
export interface Assignment {
  id: string
  classId: string
  ownerId: string
  title: string
  questionVersionIds: string[]
  recipientIds: string[]
  dueAt?: number
  createdAt?: number
}

/** A question version — content is versioned per ФИПИ year (ECLASS-20). */
export interface QuestionVersion {
  id: string
  subjectVersionId: string
  /** Discriminator for the answer/scoring strategy. */
  type: 'single-choice' | 'multiple-choice' | 'short-text' | 'extended-text'
  /** Immutable once published; only a new version can change it. */
  published: boolean
}

/**
 * A submission is one student's attempt at one assignment. Its lifecycle is
 * the heart of the platform — see `lifecycle.ts`.
 */
export interface Submission {
  id: string
  assignmentId: string
  studentId: string
  ownerId: string
  status: SubmissionStatus
  createdAt: number
  updatedAt: number
  submittedAt?: number
  checkedAt?: number
  reopenedBy?: string
  reopenReason?: string
}

export type SubmissionStatus = 'assigned' | 'in_progress' | 'submitted' | 'checked' | 'in_review'

/** One answer to one question within a submission. */
export interface Answer {
  id: string
  submissionId: string
  questionVersionId: string
  /** Free-form payload; scoring lives on the review, not the answer. */
  payload: unknown
  /** Client-supplied idempotency key so retries don't duplicate (ECLASS-30). */
  clientKey?: string
  updatedAt: number
}

/** A teacher's review of a submission. Score is derived from rubric criteria. */
export interface Review {
  id: string
  submissionId: string
  reviewerId: string
  status: 'draft' | 'finalized'
  totalScore?: number
  maxScore?: number
  finalizedAt?: number
}

/** A comment in the feedback thread attached to a submission (ECLASS-35). */
export interface Comment {
  id: string
  submissionId: string
  authorId: string
  authorRole: Role
  /** `internal` notes are never visible to the student. */
  visibility: 'public' | 'internal'
  body: string
  createdAt: number
}
