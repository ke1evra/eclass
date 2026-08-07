import { describe, expect, it } from 'vitest'
import {
  planAccountDeletion,
  ANONYMIZE_AFTER_DAYS,
  RETENTION_BY_CATEGORY,
  type RetentionCategory,
} from '@/domain/retention'

describe('data retention & deletion — ECLASS-12', () => {
  it('RETENTION_BY_CATEGORY covers the sensitive categories', () => {
    const keys = Object.keys(RETENTION_BY_CATEGORY) as RetentionCategory[]
    expect(keys).toEqual(expect.arrayContaining(['answer_text', 'audit_log', 'telemetry', 'account_metadata']))
  })

  it('answer text is retained for the exam cycle then anonymized', () => {
    expect(RETENTION_BY_CATEGORY.answer_text.action).toBe('anonymize')
    expect(RETENTION_BY_CATEGORY.answer_text.days).toBeGreaterThan(0)
  })

  it('audit log is kept longer than answer text (compliance)', () => {
    expect(RETENTION_BY_CATEGORY.audit_log.days).toBeGreaterThanOrEqual(
      RETENTION_BY_CATEGORY.answer_text.days,
    )
  })

  it('planAccountDeletion returns a scheduled, auditable plan', () => {
    const now = 1_700_000_000_000
    const plan = planAccountDeletion('stu-1', now)
    expect(plan.accountId).toBe('stu-1')
    expect(plan.requestedAt).toBe(now)
    expect(plan.scheduledAnonymizeAt).toBe(now + ANONYMIZE_AFTER_DAYS * 86_400_000)
    expect(plan.steps.length).toBeGreaterThan(0)
    // Every step must name what it does to which category — no silent drops.
    for (const step of plan.steps) {
      expect(step.category).toBeTruthy()
      expect(step.action).toBeTruthy()
    }
  })

  it('deletion plan revokes active sessions immediately', () => {
    const plan = planAccountDeletion('stu-1', 1)
    const revoke = plan.steps.find((s) => s.action === 'revoke_sessions')
    expect(revoke).toBeDefined()
    expect(revoke!.delayDays).toBe(0)
  })
})
