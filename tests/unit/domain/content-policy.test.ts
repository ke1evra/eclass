import { describe, expect, it } from 'vitest'
import {
  canPublishQuestion,
  redactPii,
  CONTENT_SOURCES,
  isAllowedSource,
  type QuestionDraft,
} from '@/domain/content-policy'

const validDraft = (over: Partial<QuestionDraft> = {}): QuestionDraft => ({
  id: 'q-1',
  subjectVersionId: 'subj-math-2026',
  source: { kind: 'fipi', ref: 'ege-2026-bank', url: 'https://fipi.ru/...' },
  editorStatus: 'reviewed',
  type: 'single-choice',
  ...over,
})

describe('content publish gate — ECLASS-12', () => {
  it('publishes a valid ФИПИ question with source + version + editor review', () => {
    const d = canPublishQuestion(validDraft())
    expect(d.allowed).toBe(true)
  })

  it('rejects a draft with no source', () => {
    const d = canPublishQuestion(validDraft({ source: undefined }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/source/i)
  })

  it('rejects a draft with no subject version', () => {
    const d = canPublishQuestion(validDraft({ subjectVersionId: '' }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/version/i)
  })

  it('rejects a draft not reviewed by an editor', () => {
    const d = canPublishQuestion(validDraft({ editorStatus: 'draft' }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/editor|review/i)
  })

  it('rejects a draft from a disallowed source kind', () => {
    const d = canPublishQuestion(
      validDraft({ source: { kind: 'unknown', ref: 'x' } as unknown as QuestionDraft['source'] }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/source/i)
  })

  it('isAllowedSource recognises ФИПИ and authored originals only', () => {
    expect(isAllowedSource({ kind: 'fipi', ref: 'x' })).toBe(true)
    expect(isAllowedSource({ kind: 'authored', ref: 'original', license: 'CC-BY' })).toBe(true)
    expect(isAllowedSource({ kind: 'unknown', ref: 'x' })).toBe(false)
    expect(isAllowedSource({ kind: 'copied', ref: 'stolen' })).toBe(false)
  })

  it('CONTENT_SOURCES enumerates the allowed sourcing channels', () => {
    expect(CONTENT_SOURCES).toContain('fipi')
    expect(CONTENT_SOURCES).toContain('authored')
    expect(CONTENT_SOURCES).not.toContain('copied')
  })

  it('rejects an authored original without a license/permission', () => {
    const d = canPublishQuestion(
      validDraft({ source: { kind: 'authored', ref: 'original' } }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/license/i)
  })

  it('publishes an authored original WITH a license', () => {
    const d = canPublishQuestion(
      validDraft({ source: { kind: 'authored', ref: 'original', license: 'CC-BY' } }),
    )
    expect(d.allowed).toBe(true)
  })
})

describe('PII redaction — ECLASS-12', () => {
  it('strips email-like tokens from a log line', () => {
    const out = redactPii('student ivan@mail.ru submitted answer')
    expect(out).not.toContain('ivan@mail.ru')
    expect(out).toContain('[redacted:email]')
  })

  it('strips Russian phone numbers', () => {
    const out = redactPii('call me +7 (999) 123-45-67 please')
    expect(out).not.toContain('+7 (999) 123-45-67')
    expect(out).toContain('[redacted:phone]')
  })

  it('strips long answer-like text blobs (heuristic: >40 chars quoted)', () => {
    const longAnswer = 'Я считаю, что правильный ответ состоит в следующем рассуждении о функциях...'
    const out = redactPii(`feedback: "${longAnswer}"`)
    expect(out).not.toContain(longAnswer)
    expect(out).toContain('[redacted:answer]')
  })

  it('does not touch normal short audit text', () => {
    const out = redactPii('submission sub-1 transitioned to submitted')
    expect(out).toBe('submission sub-1 transitioned to submitted')
  })

  it('redacts a structured audit event, leaving stable ids', () => {
    const event = {
      type: 'submission_submitted',
      actorId: 'stu-1',
      email: 'leak@leak.ru',
      answerText: 'x'.repeat(60),
      resourceId: 'sub-1',
    }
    const out = redactPii(JSON.stringify(event))
    expect(out).not.toContain('leak@leak.ru')
    expect(out).not.toContain('x'.repeat(60))
    expect(out).toContain('stu-1')
    expect(out).toContain('sub-1')
  })
})
