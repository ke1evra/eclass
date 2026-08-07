import { beforeEach, describe, expect, it } from 'vitest'
import {
  assignmentFactory,
  answerFactory,
  classFactory,
  commentFactory,
  questionFactory,
  resetFactoryIds,
  reviewFactory,
  studentFactory,
  submissionFactory,
  userFactory,
} from '../factories'

/**
 * Factory smoke tests — ECLASS-11.
 *
 * These guard the test-data contract: factories produce valid domain entities,
 * are deterministic, and never carry PII by default. If a domain field becomes
 * required, the factory starts emitting it and these tests keep the shape
 * honest.
 */
describe('test factories — ECLASS-11', () => {
  beforeEach(resetFactoryIds)

  it('produce stable, sequential IDs across a file', () => {
    const a = classFactory()
    const b = classFactory()
    expect(a.id).toBe('cls-1')
    expect(b.id).toBe('cls-2')
  })

  it('respect overrides without leaking defaults', () => {
    const s = submissionFactory({ studentId: 'stu-99', status: 'submitted' })
    expect(s.studentId).toBe('stu-99')
    expect(s.status).toBe('submitted')
    expect(s.assignmentId).toBe('asg-1') // default preserved
  })

  it('assignment factory always provides explicit recipients', () => {
    const a = assignmentFactory()
    expect(a.recipientIds.length).toBeGreaterThan(0)
  })

  it('answer factory always provides an idempotency clientKey', () => {
    const a = answerFactory()
    expect(a.clientKey).toBeTruthy()
    expect(a.clientKey!.length).toBeGreaterThanOrEqual(8)
  })

  it('user factory tags role correctly', () => {
    expect(userFactory({ role: 'teacher' }).role).toBe('teacher')
    expect(userFactory({ role: 'student' }).role).toBe('student')
  })

  it('entities compose into a coherent critical-slice graph', () => {
    const cls = classFactory()
    const stu = studentFactory({ classId: cls.id })
    const asg = assignmentFactory({ classId: cls.id, recipientIds: [stu.id] })
    const sub = submissionFactory({ assignmentId: asg.id, studentId: stu.id })
    const ans = answerFactory({ submissionId: sub.id })
    const rev = reviewFactory({ submissionId: sub.id })
    const cmt = commentFactory({ submissionId: sub.id })

    expect(ans.submissionId).toBe(sub.id)
    expect(rev.submissionId).toBe(sub.id)
    expect(cmt.submissionId).toBe(sub.id)
    expect(asg.recipientIds).toContain(stu.id)
  })

  it('question factory defaults to published content', () => {
    expect(questionFactory().published).toBe(true)
  })
})
