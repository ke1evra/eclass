/**
 * Security audit trail — ECLASS-17.
 *
 * Records actor/action/resource/time for security-relevant events WITHOUT
 * carrying PII payload. Every mutating endpoint funnels through `recordAudit`.
 * The shape is deliberately minimal and PII-free by construction (no email,
 * name, or answer-text field exists on this type).
 */
import { redactPii } from '@/domain/content-policy'

export interface AuditEntry {
  /** Stable opaque actor id (tenant-scoped). NEVER an email. */
  actorId: string
  actorRole: 'teacher' | 'student' | 'admin' | 'anonymous'
  action: string
  resourceType: string
  resourceId: string
  /** Epoch millis. */
  at: number
  /** Outcome of the attempted action — security reviews denied attempts. */
  outcome: 'allowed' | 'denied'
  /** Free-form reason (denial code etc.), PII-redacted before storage. */
  reason?: string
  /** Request correlation id for support/security review. */
  requestId?: string
}

export interface AuditSink {
  append(entry: AuditEntry): void | Promise<void>
}

export function createAuditRecorder(sink: AuditSink, clock: { now(): number }) {
  return {
    async record(input: {
      actorId: string
      actorRole: AuditEntry['actorRole']
      action: string
      resourceType: string
      resourceId: string
      outcome?: AuditEntry['outcome']
      reason?: string
      requestId?: string
    }): Promise<AuditEntry> {
      const entry: AuditEntry = {
        actorId: input.actorId,
        actorRole: input.actorRole,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        at: clock.now(),
        outcome: input.outcome ?? 'allowed',
        reason: input.reason ? redactPii(input.reason) : undefined,
        requestId: input.requestId,
      }
      await sink.append(entry)
      return entry
    },
  }
}
