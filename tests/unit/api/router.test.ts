import { describe, expect, it } from 'vitest'
import {
  handleCreateAssignment,
  handleCreateClass,
  handleReview,
  handleSubmit,
  handleUpsertAnswer,
} from '@/api/router'
import type { Actor } from '@/domain/authorization'
import { submissionFactory } from '../../factories'

const teacher = (id = 'tea-1'): Actor => ({ id, role: 'teacher' })
const student = (id = 'stu-1'): Actor => ({ id, role: 'student' })
const admin = (id = 'adm-1'): Actor => ({ id, role: 'admin' })
const foreign = (id = 'tea-other'): Actor => ({ id, role: 'teacher' })

describe('router branch coverage — ECLASS-11', () => {
  it('createAssignment rejects empty recipients', async () => {
    const res = await handleCreateAssignment(
      { classId: 'cls-1', title: 'x', questionVersionIds: ['q-1'], recipientIds: [] },
      teacher(),
    )
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('validation_error')
  })

  it('createAssignment succeeds for the class owner', async () => {
    const res = await handleCreateAssignment(
      {
        classId: 'cls-1',
        title: 'Вариант 2',
        questionVersionIds: ['q-1', 'q-2'],
        recipientIds: ['stu-1'],
      },
      teacher(),
    )
    expect(res.status).toBe(200)
    expect(res.body.recipientIds).toEqual(['stu-1'])
  })

  it('createAssignment is forbidden for a student (role mismatch)', async () => {
    const res = await handleCreateAssignment(
      { classId: 'cls-1', title: 'x', questionVersionIds: ['q-1'], recipientIds: ['stu-1'] },
      student(),
    )
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('forbidden')
  })

  it('upsertAnswer validates the body', async () => {
    const res = await handleUpsertAnswer({ questionVersionId: 'q-1' }, teacher())
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('validation_error')
  })

  it('upsertAnswer accepts a valid autosave', async () => {
    const res = await handleUpsertAnswer(
      { questionVersionId: 'q-1', idempotencyKey: 'autosave-1234', payload: { value: 'B' } },
      teacher(),
    )
    expect(res.status).toBe(200)
    expect(res.body.answerId).toBeTruthy()
  })

  it('review without finalize stays in draft', async () => {
    const submission = submissionFactory({ status: 'submitted', submittedAt: 1 })
    const res = await handleReview(
      submission,
      { criterionScores: [{ rubricCriterionId: 'rc-1', score: 1 }], finalize: false },
      teacher(),
    )
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('draft')
    expect(res.body.finalizedAt).toBeNull()
  })

  it('review on a non-submitted submission returns conflict (invalid_transition)', async () => {
    const submission = submissionFactory({ status: 'assigned' })
    const res = await handleReview(
      submission,
      {
        criterionScores: [{ rubricCriterionId: 'rc-1', score: 1 }],
        finalize: true,
      },
      teacher(),
    )
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('invalid_transition')
  })

  it('review by a foreign teacher returns not_found', async () => {
    const submission = submissionFactory({ status: 'submitted', submittedAt: 1 })
    const res = await handleReview(
      submission,
      { criterionScores: [{ rubricCriterionId: 'rc-1', score: 1 }], finalize: false },
      foreign(),
    )
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('not_found')
  })

  it('admin cannot create a class (mutation forbidden)', async () => {
    const res = await handleCreateClass(
      { name: 'x', subjectVersionId: 'subj-math-2026' },
      admin(),
    )
    expect(res.status).toBe(403)
  })

  it('student submitting someone else’s work gets not_found', async () => {
    const submission = submissionFactory({ status: 'in_progress', studentId: 'stu-other' })
    const res = await handleSubmit(
      submission,
      { idempotencyKey: 'student-key-1' },
      student('stu-1'),
    )
    expect(res.status).toBe(404)
  })
})

describe('router branch hardening (review step 7)', () => {
  it('review with a malformed body returns validation_error 422 with field errors', async () => {
    const submission = submissionFactory({ status: 'submitted', submittedAt: 1 })
    const res = await handleReview(submission, { criterionScores: 'not-an-array' }, teacher())
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('validation_error')
    expect(res.body.errors).toBeTruthy()
  })

  it('submit on a draft (never started) submission returns invalid_transition', async () => {
    const submission = submissionFactory({ status: 'assigned', submittedAt: undefined })
    const res = await handleSubmit(
      submission,
      { answers: [], idempotencyKey: 'abcdefgh' },
      student(),
    )
    expect([409, 422]).toContain(res.status)
    if (res.status === 409) expect(res.body.code).toBe('invalid_transition')
  })
})
