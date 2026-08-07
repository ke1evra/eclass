import { describe, expect, it } from 'vitest'
import { METRICS, meetsTarget, USER_NEEDS, type FunnelEvent } from './contract'

const T = (at: number, partial: Omit<FunnelEvent, 'at'>): FunnelEvent => ({ at, ...partial })

describe('metrics contract — ECLASS-8', () => {
  it('defines exactly five user needs, each linked to MVP features', () => {
    expect(USER_NEEDS).toHaveLength(5)
    for (const need of USER_NEEDS) {
      expect(need.mvpFeatures.length).toBeGreaterThan(0)
      expect(need.statement).toBeTruthy()
    }
  })

  it('targets match the AI-locked MVP success criteria', () => {
    expect(METRICS.teacher_activation.target).toBe(60)
    expect(METRICS.student_completion.target).toBe(70)
    expect(METRICS.feedback_sla_hours.target).toBe(24)
    expect(METRICS.week2_retention.target).toBe(35)
    expect(METRICS.time_to_first_assignment_minutes.target).toBe(10)
  })

  it('computes teacher activation as activated / signed up', () => {
    const events: FunnelEvent[] = [
      T(1, { type: 'teacher_activated', actorId: 't1' }),
      T(2, { type: 'teacher_activated', actorId: 't2' }),
      T(3, { type: 'teacher_activated', actorId: 't3' }),
      T(10, { type: 'assignment_created', actorId: 't1' }),
      T(11, { type: 'assignment_created', actorId: 't2' }),
    ]
    expect(METRICS.teacher_activation.compute(events)).toBe(67) // 2 of 3
    expect(meetsTarget('teacher_activation', METRICS.teacher_activation.compute(events))).toBe(true)
  })

  it('computes student completion only on finalized submissions', () => {
    const events: FunnelEvent[] = [
      T(1, { type: 'submission_started', actorId: 's1' }),
      T(2, { type: 'submission_started', actorId: 's2' }),
      T(3, { type: 'submission_started', actorId: 's3' }),
      T(4, { type: 'submission_submitted', actorId: 's1' }),
      T(5, { type: 'submission_submitted', actorId: 's3' }),
    ]
    expect(METRICS.student_completion.compute(events)).toBe(67)
  })

  it('computes feedback SLA as median hours between submit and feedback', () => {
    const HOUR = 3_600_000
    const events: FunnelEvent[] = [
      T(0, { type: 'submission_submitted', actorId: 's1' }),
      T(20 * HOUR, { type: 'feedback_sent', actorId: 's1' }),
      T(0, { type: 'submission_submitted', actorId: 's2' }),
      T(40 * HOUR, { type: 'feedback_sent', actorId: 's2' }),
      T(0, { type: 'submission_submitted', actorId: 's3' }),
      T(30 * HOUR, { type: 'feedback_sent', actorId: 's3' }),
    ]
    // waits: 20, 40, 30 → median 30
    expect(METRICS.feedback_sla_hours.compute(events)).toBe(30)
    expect(meetsTarget('feedback_sla_hours', 30)).toBe(false)
  })

  it('computes week-2 retention in the 7–14 day window after first submit', () => {
    const DAY = 24 * 3_600_000
    const events: FunnelEvent[] = [
      T(0, { type: 'submission_submitted', actorId: 's1' }),
      T(0, { type: 'submission_submitted', actorId: 's2' }),
      T(0, { type: 'submission_submitted', actorId: 's3' }),
      T(10 * DAY, { type: 'student_returned', actorId: 's1' }), // in window
      T(3 * DAY, { type: 'student_returned', actorId: 's2' }), // too early
      T(20 * DAY, { type: 'student_returned', actorId: 's3' }), // too late
    ]
    expect(METRICS.week2_retention.compute(events)).toBe(33) // 1 of 3
  })

  it('computes time-to-first-assignment as median minutes from signup', () => {
    const MIN = 60_000
    const events: FunnelEvent[] = [
      T(0, { type: 'teacher_activated', actorId: 't1' }),
      T(8 * MIN, { type: 'assignment_created', actorId: 't1' }),
      T(0, { type: 'teacher_activated', actorId: 't2' }),
      T(12 * MIN, { type: 'assignment_created', actorId: 't2' }),
    ]
    expect(METRICS.time_to_first_assignment_minutes.compute(events)).toBe(10) // median(8,12)
  })
})
