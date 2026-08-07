import { describe, expect, it } from 'vitest'
import {
  startSubmission,
  submitSubmission,
  checkSubmission,
  reopenSubmissionForReview,
  type Submission,
  type SubmissionStatus,
} from '@/domain/lifecycle'

const assigned = (over: Partial<Submission> = {}): Submission => ({
  id: 'sub-1',
  assignmentId: 'asg-1',
  studentId: 'stu-1',
  ownerId: 'tea-1',
  status: 'assigned',
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
})

describe('submission lifecycle — ECLASS-9', () => {
  describe('valid forward transitions', () => {
    it('assigned → in_progress via startSubmission', () => {
      const next = startSubmission(assigned())
      expect(next.status).toBe('in_progress')
      expect(next.updatedAt).toBeGreaterThanOrEqual(next.createdAt)
    })

    it('in_progress → submitted via submitSubmission (finalized)', () => {
      const started = startSubmission(assigned())
      const submitted = submitSubmission(started)
      expect(submitted.status).toBe('submitted')
      expect(submitted.submittedAt).toBeTypeOf('number')
    })

    it('submitted → checked via checkSubmission', () => {
      const submitted = submitSubmission(startSubmission(assigned()))
      const checked = checkSubmission(submitted)
      expect(checked.status).toBe('checked')
    })
  })

  describe('forbidden transitions throw a typed error', () => {
    const expectForbidden = (fn: () => unknown, from: SubmissionStatus, to: SubmissionStatus) => {
      expect(fn).toThrow()
      try {
        fn()
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
        const e = err as Error & { code?: string; from?: string; to?: string }
        expect(e.code).toBe('invalid_transition')
        expect(e.from).toBe(from)
        expect(e.to).toBe(to)
      }
    }

    it('cannot submit an assignment that was not started', () => {
      expectForbidden(() => submitSubmission(assigned()), 'assigned', 'submitted')
    })

    it('cannot check a submission that was not submitted', () => {
      expectForbidden(() => checkSubmission(startSubmission(assigned())), 'in_progress', 'checked')
    })

    it('cannot start an already-in-progress submission', () => {
      expectForbidden(() => startSubmission(startSubmission(assigned())), 'in_progress', 'in_progress')
    })

    it('cannot re-submit a checked submission directly', () => {
      const checked = checkSubmission(submitSubmission(startSubmission(assigned())))
      expectForbidden(() => submitSubmission(checked), 'checked', 'submitted')
    })

    it('reopen for review is the only way back from checked, and records a reason', () => {
      const checked = checkSubmission(submitSubmission(startSubmission(assigned())))
      const reopened = reopenSubmissionForReview(checked, { by: 'tea-1', reason: 'score dispute' })
      expect(reopened.status).toBe('in_review')
      expect(reopened.reopenedBy).toBe('tea-1')
    })
  })
})
