/**
 * Content policy — ECLASS-12 (TDD-P0-05).
 *
 * Codifies "what may be published" and "what may never enter logs". Both are
 * acceptance criteria of the task and NFRs of the project:
 *
 *   - A question without a verifiable source + subject version + editor review
 *     can NEVER be published. This is the editorial gate against the
 *     "errors in assignments" pain reported for ЯКласс.
 *   - PII (email, phone, long answer text) must never appear in technical
 *     logs. `redactPii` is the single chokepoint every audit/log line passes
 *     through.
 */
import { z } from 'zod'
import { QuestionType } from '../api/contracts'

/** Question type discriminator, derived from the zod contract. */
type QuestionTypeValue = z.infer<typeof QuestionType>

export type ContentSourceKind = 'fipi' | 'authored'

export const CONTENT_SOURCES: readonly ContentSourceKind[] = ['fipi', 'authored'] as const

export interface ContentSource {
  kind: ContentSourceKind
  /** Stable reference into the source (ФИПИ bank id, original doc id, etc.). */
  ref: string
  url?: string
  /** Required for authored originals; proves we have rights to publish. */
  license?: string
}

export type EditorStatus = 'draft' | 'in_review' | 'reviewed' | 'published' | 'retired'

export interface QuestionDraft {
  id: string
  subjectVersionId: string
  type: QuestionTypeValue
  source?: ContentSource
  editorStatus: EditorStatus
}

export type PublishDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

/** A source is allowed if its kind is in the canonical list. */
export function isAllowedSource(source: unknown): source is ContentSource {
  if (typeof source !== 'object' || source === null) return false
  const s = source as { kind?: unknown }
  return (CONTENT_SOURCES as readonly string[]).includes(s.kind as string)
}

/**
 * The editorial publish gate. Returns a decision explaining exactly why a
 * draft may not be published — so the editor UI can show actionable guidance
 * instead of a generic "no".
 */
export function canPublishQuestion(draft: QuestionDraft): PublishDecision {
  if (!draft.subjectVersionId || draft.subjectVersionId.trim() === '') {
    return { allowed: false, reason: 'missing subject version' }
  }
  if (!draft.source || !isAllowedSource(draft.source)) {
    return { allowed: false, reason: 'missing or disallowed content source' }
  }
  if (draft.source.kind === 'authored' && !draft.source.license) {
    return { allowed: false, reason: 'authored original requires a license/permission' }
  }
  if (draft.editorStatus !== 'reviewed') {
    return { allowed: false, reason: 'editor review not complete (status must be reviewed)' }
  }
  return { allowed: true }
}

/* -------------------------------------------------------------------------- */
/* PII redaction — the single chokepoint for any technical log line           */
/* -------------------------------------------------------------------------- */

interface RedactionRule {
  name: string
  pattern: RegExp
  replacement: string
}

const RULES: RedactionRule[] = [
  // Email — local@domain
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[redacted:email]' },
  // Russian phone formats: +7 (XXX) XXX-XX-XX, 8XXXXXXXXXX
  { name: 'phone', pattern: /(?:\+7|8)\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g, replacement: '[redacted:phone]' },
  // Long answer-like text: a quoted run of >40 chars — heuristic, intentionally
  // conservative. Real answer payloads are never logged by structure; this
  // catches accidental copy-paste into a log statement.
  { name: 'answer', pattern: /"[^"]{40,}"/g, replacement: '[redacted:answer]' },
]

/**
 * Redact PII from an arbitrary string (audit line, structured event JSON, etc.).
 * Pure and deterministic. MUST be applied before any line reaches a log sink.
 */
export function redactPii(input: string): string {
  let out = input
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replacement)
  }
  return out
}
