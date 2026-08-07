/**
 * Data retention & deletion — ECLASS-12.
 *
 * Codifies how long each category of personal data lives, and what happens at
 * the end (anonymize vs delete), plus the account-deletion flow required by
 * 152-ФЗ. Nothing here touches a real DB — it is the policy that the storage
 * layer (Payload hooks, scheduled jobs in ECLASS-38) will enforce.
 */

export type RetentionCategory =
  | 'answer_text' // student answers to questions
  | 'audit_log' // security/compliance audit trail
  | 'telemetry' // privacy-safe product events
  | 'account_metadata' // class membership, role, display name

export type RetentionAction = 'anonymize' | 'delete' | 'keep' | 'revoke_sessions'

export interface RetentionPolicy {
  days: number
  action: RetentionAction
  /** Why this category is retained — for the privacy notice and auditors. */
  reason: string
}

/**
 * Retention windows. Tuned to be the minimum compatible with:
 *   - exam-cycle learning value (answers),
 *   - regulatory audit needs (audit log kept longer than answers),
 *   - no permanent storage of raw PII in telemetry.
 */
export const RETENTION_BY_CATEGORY: Record<RetentionCategory, RetentionPolicy> = {
  // Answers are useful within the school year; after that they are anonymized
  // so we keep aggregate learning signal without keeping the student's text.
  answer_text: {
    days: 365,
    action: 'anonymize',
    reason: 'учебная ценность в течение учебного года; далее — анонимизация агрегатов',
  },
  // Audit trail is kept longer than answers for security/compliance review.
  audit_log: {
    days: 730,
    action: 'keep',
    reason: 'требования безопасности и расследования инцидентов',
  },
  // Product telemetry must not carry PII; it can be deleted on a shorter cycle.
  telemetry: {
    days: 90,
    action: 'delete',
    reason: 'только агрегатная продуктовая аналитика без PII',
  },
  // Account metadata lives with the account until deletion is requested.
  account_metadata: {
    days: 0,
    action: 'anonymize',
    reason: 'хранится до запроса на удаление аккаунта',
  },
}

/** Grace period before an account-deletion request anonymizes data. */
export const ANONYMIZE_AFTER_DAYS = 30

export interface DeletionStep {
  category: RetentionCategory
  action: RetentionAction
  /** Days from the request timestamp before this step runs. */
  delayDays: number
}

export interface AccountDeletionPlan {
  accountId: string
  requestedAt: number
  scheduledAnonymizeAt: number
  steps: DeletionStep[]
}

/**
 * Build the deletion plan for an account. Revocation of sessions is immediate;
 * anonymization of content happens after the grace period (so a user who
 * requests deletion by mistake has a window to recover). Every step names its
 * category and action so nothing is silently dropped.
 */
export function planAccountDeletion(accountId: string, requestedAt: number): AccountDeletionPlan {
  const ms = (days: number) => days * 86_400_000
  return {
    accountId,
    requestedAt,
    scheduledAnonymizeAt: requestedAt + ms(ANONYMIZE_AFTER_DAYS),
    steps: [
      { category: 'account_metadata', action: 'revoke_sessions', delayDays: 0 },
      { category: 'answer_text', action: 'anonymize', delayDays: ANONYMIZE_AFTER_DAYS },
      { category: 'telemetry', action: 'delete', delayDays: ANONYMIZE_AFTER_DAYS },
      { category: 'account_metadata', action: 'anonymize', delayDays: ANONYMIZE_AFTER_DAYS },
      // Audit log is intentionally NOT deleted on account deletion — it is
      // retained per its own policy for security.
    ],
  }
}
