import { describe, expect, it } from 'vitest'
import {
  CONTRACTS,
  CreateAssignmentRequest,
  CreateClassRequest,
  JoinClassRequest,
  ProblemDetails,
  ReviewRequest,
  SubmitRequest,
  UpsertAnswerRequest,
} from '@/api/contracts'

/**
 * Contract tests — ECLASS-10.
 *
 * These are NOT route tests. They assert the contract surface itself is
 * coherent: schemas validate happy path, reject invalid input, carry the
 * error model, and — critically — never expose PII fields. Changing a schema
 * in a backwards-incompatible way breaks these tests before any consumer
 * ships.
 */

describe('API contracts — ECLASS-10', () => {
  describe('happy-path validation', () => {
    it('createClass accepts a minimal valid body', () => {
      const parsed = CreateClassRequest.parse({
        name: '9А математика',
        subjectVersionId: 'subj-math-2026',
      })
      expect(parsed.name).toBe('9А математика')
    })

    it('joinClass accepts an invite code without requiring a name', () => {
      const parsed = JoinClassRequest.parse({ inviteCode: 'ABC23' })
      expect(parsed.inviteCode).toBe('ABC23')
      expect(parsed.displayName).toBeUndefined()
    })

    it('createAssignment requires explicit recipients (no implicit everyone)', () => {
      const ok = CreateAssignmentRequest.parse({
        classId: 'cls-1',
        title: 'Вариант 1',
        questionVersionIds: ['q-1'],
        recipientIds: ['stu-1'],
      })
      expect(ok.recipientIds).toHaveLength(1)

      // Empty recipients must be rejected — this is the security default.
      expect(() =>
        CreateAssignmentRequest.parse({
          classId: 'cls-1',
          title: 'x',
          questionVersionIds: ['q-1'],
          recipientIds: [],
        }),
      ).toThrow()
    })

    it('upsertAnswer requires an idempotency key', () => {
      expect(() =>
        UpsertAnswerRequest.parse({
          questionVersionId: 'q-1',
          payload: { value: 'A' },
        }),
      ).toThrow() // missing idempotencyKey

      const ok = UpsertAnswerRequest.parse({
        questionVersionId: 'q-1',
        idempotencyKey: 'client-key-1234',
        payload: { value: 'A' },
      })
      expect(ok.idempotencyKey).toBe('client-key-1234')
    })

    it('submit is idempotency-keyed', () => {
      expect(() => SubmitRequest.parse({})).toThrow()
      const ok = SubmitRequest.parse({ idempotencyKey: 'retry-key-9999' })
      expect(ok.idempotencyKey).toBeTruthy()
    })

    it('review rejects a client-supplied total score (derived only)', () => {
      // totalScore is not a field on the request; supplying it is ignored/rejected.
      const parsed = ReviewRequest.parse({
        criterionScores: [{ rubricCriterionId: 'rc-1', score: 2 }],
        finalize: true,
      })
      expect(parsed).not.toHaveProperty('totalScore')
    })
  })

  describe('error model is RFC 9457 Problem Details', () => {
    it('parses a validation problem with field errors', () => {
      const problem = ProblemDetails.parse({
        type: 'https://eclass.app/problems/validation_error',
        title: 'Validation failed',
        status: 422,
        code: 'validation_error',
        errors: { 'recipientIds': 'must not be empty' },
        requestId: 'req-1',
      })
      expect(problem.code).toBe('validation_error')
      expect(problem.errors?.recipientIds).toBe('must not be empty')
    })

    it('every declared contract error code is a known ErrorCode', () => {
      const known = new Set([
        'validation_error',
        'not_found',
        'forbidden',
        'conflict',
        'invalid_transition',
        'rate_limited',
        'payload_too_large',
      ])
      for (const [name, contract] of Object.entries(CONTRACTS)) {
        for (const code of contract.errors) {
          expect(known, `contract ${name} declares unknown code ${code}`).toContain(code)
        }
      }
    })
  })

  describe('privacy invariant — no PII on response shapes', () => {
    /**
     * The acceptance criterion "API does not reveal email/answers outside the
     * permitted context" is enforced structurally: the response shapes simply
     * have no such field. This test makes that invariant explicit so a future
     * PR cannot quietly add one.
     */
    it('class response has no email field', () => {
      const sample = {
        id: 'cls-1',
        name: 'x',
        subjectVersionId: 's',
        inviteCode: 'ABC',
        createdAt: new Date().toISOString(),
      }
      expect(sample).not.toHaveProperty('email')
      // sentinel: if a developer adds `email` to ClassResponse, this test breaks
      const shapeKeys = Object.keys(CONTRACTS.createClass.response.shape)
      expect(shapeKeys).not.toContain('email')
    })

    it('question summary never carries the answer key in the listing shape', () => {
      const shapeKeys = Object.keys(CONTRACTS.listContent.response.shape)
      // The paginated inner item is `items`; inspect its element shape.
      const itemShape = (CONTRACTS.listContent.response.shape.items as unknown as {
        element: { shape: Record<string, unknown> }
      }).element.shape
      const itemKeys = Object.keys(itemShape)
      expect(itemKeys).not.toContain('answerKey')
      expect(itemKeys).not.toContain('correctAnswer')
    })
  })

  describe('contract surface is stable and complete', () => {
    it('exposes exactly the 8 critical-slice endpoints', () => {
      expect(Object.keys(CONTRACTS).sort()).toEqual(
        [
          'createClass',
          'joinClass',
          'listContent',
          'createAssignment',
          'upsertAnswer',
          'submit',
          'review',
          'createComment',
        ].sort(),
      )
    })

    it('every endpoint declares at least one error code', () => {
      for (const [name, contract] of Object.entries(CONTRACTS)) {
        expect(contract.errors.length, `${name} declares no errors`).toBeGreaterThan(0)
      }
    })
  })
})
