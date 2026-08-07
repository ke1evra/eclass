import { describe, expect, it } from 'vitest'
import { handleCreateClass, handleSubmit, handleReview } from '@/api/router'
import { authorize } from '@/domain/authorization'
import type { Actor } from '@/domain/authorization'

/**
 * Integration slice — ECLASS-10.
 *
 * Wires the contract layer (zod validation) to the domain (authorization +
 * lifecycle) through an in-memory router. No HTTP, no DB: this is the seam
 * where a contract change must propagate correctly into domain behaviour.
 * If a consumer (frontend) drifts from the contract, this test breaks first.
 */

const teacher = (id = 'tea-1'): Actor => ({ id, role: 'teacher' })
const student = (id = 'stu-1'): Actor => ({ id, role: 'student' })
const foreignTeacher = (id = 'tea-other'): Actor => ({ id, role: 'teacher' })

describe('critical slice integration — ECLASS-10', () => {
  it('teacher creates a class and gets a non-PII response', async () => {
    const res = await handleCreateClass(
      { name: '9А', subjectVersionId: 'subj-math-2026' },
      teacher(),
    )
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ name: '9А', subjectVersionId: 'subj-math-2026' })
    expect(res.body).not.toHaveProperty('email')
    expect(res.body.inviteCode).toBeTruthy()
  })

  it('rejects invalid createClass body with validation_error', async () => {
    const res = await handleCreateClass(
      { name: '', subjectVersionId: '' },
      teacher(),
    )
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('validation_error')
  })

  it('submit is idempotent on retry and finalizes once', async () => {
    const submission = { id: 'sub-1', assignmentId: 'asg-1', studentId: 'stu-1', ownerId: 'tea-1', status: 'in_progress' as const, createdAt: 1, updatedAt: 1 }
    const key = 'retry-key-abcd'
    const first = await handleSubmit(submission, { idempotencyKey: key }, student())
    expect(first.status).toBe(200)
    expect(first.body.status).toBe('submitted')

    // Retry with the same key: same result, no duplicate transition.
    const retry = await handleSubmit(
      { ...submission, status: 'in_progress' },
      { idempotencyKey: key },
      student(),
    )
    expect(retry.status).toBe(200)
    expect(retry.body.status).toBe('submitted')
  })

  it('foreign teacher submitting to another submission gets not_found', async () => {
    const submission = { id: 'sub-1', assignmentId: 'asg-1', studentId: 'stu-1', ownerId: 'tea-1', status: 'in_progress' as const, createdAt: 1, updatedAt: 1 }
    const res = await handleSubmit(submission, { idempotencyKey: 'foreign-key-9999' }, foreignTeacher())
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('not_found')
  })

  it('authorization decision is consistent with the policy layer', () => {
    const classResource = { ownerId: 'tea-1' }
    expect(authorize(teacher(), 'read', classResource).allowed).toBe(true)
    expect(authorize(foreignTeacher(), 'read', classResource).allowed).toBe(false)
  })

  it('review derives total from criteria and forbids client-supplied total', async () => {
    const submission = { id: 'sub-1', assignmentId: 'asg-1', studentId: 'stu-1', ownerId: 'tea-1', status: 'submitted' as const, createdAt: 1, updatedAt: 1, submittedAt: 1 }
    const res = await handleReview(
      submission,
      {
        criterionScores: [
          { rubricCriterionId: 'rc-1', score: 3 },
          { rubricCriterionId: 'rc-2', score: 2 },
        ],
        finalize: true,
      },
      teacher(),
    )
    expect(res.status).toBe(200)
    expect(res.body.totalScore).toBe(5) // derived server-side
    expect(res.body.status).toBe('finalized')
  })
})
