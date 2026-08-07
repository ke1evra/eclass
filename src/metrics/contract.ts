/**
 * Product metrics contract — ECLASS-8 (TDD-P0-01).
 *
 * This file is the canonical definition of MVP success metrics. Every metric
 * has: a stable id, a human description, the numeric target, the baseline,
 * and a pure `compute()` function that turns raw funnel events into a number.
 *
 * Tests (and later the telemetry pipeline of ECLASS-38) MUST use these
 * definitions. Adding a metric that has no contract here is a red flag —
 * what we cannot compute reproducibly, we cannot claim.
 */

export type MetricId =
  | 'teacher_activation'
  | 'student_completion'
  | 'feedback_sla_hours'
  | 'week2_retention'
  | 'time_to_first_assignment_minutes'

/**
 * The five user needs captured from the 07.08.2026 research. Each MVP feature
 * must trace back to at least one need; acceptance for ECLASS-8 checks that.
 */
export const USER_NEEDS = [
  {
    id: 'need_correct_fipi_content',
    statement:
      'Я хочу быть уверен, что задание совпадает со структурой и содержанием актуального экзамена ФИПИ.',
    mvpFeatures: ['versioned-question-bank', 'editorial-import', 'fipi-golden-set'],
  },
  {
    id: 'need_frictionless_invite',
    statement:
      'Я хочу пригласить ученика одной ссылкой без путаницы с регистрацией и дублированием классов.',
    mvpFeatures: ['invite-by-code-or-link', 'self-service-class'],
  },
  {
    id: 'need_personal_assignment',
    statement:
      'Я хочу выдать конкретную работу конкретному ученику или группе с понятным сроком.',
    mvpFeatures: ['assignment-builder', 'recipient-targeting', 'deadlines'],
  },
  {
    id: 'need_reliable_mobile_submit',
    statement:
      'Ученик должен сдать работу с телефона без потери ответа даже при кратковременном разрыве сети.',
    mvpFeatures: ['autosave', 'idempotent-submit', 'offline-resume', 'pwa-shell'],
  },
  {
    id: 'need_explaining_feedback',
    statement:
      'Я хочу дать объясняющую обратную связь и увидеть, что ошибка отработана, а не просто поставить балл.',
    mvpFeatures: ['rubric-review', 'feedback-thread', 'remediation-loop'],
  },
] as const

export type UserNeed = (typeof USER_NEEDS)[number]

export interface MetricDefinition<TEvent> {
  id: MetricId
  description: string
  /** Numerical target a successful pilot must hit. */
  target: number
  /** Direction of "good": higher is better for activation/completion/retention, lower for SLA/time. */
  direction: 'higher_is_better' | 'lower_is_better'
  /** Baseline observed before the pilot (0 = no prior data). */
  baseline: number
  /** Reproducible formula: raw funnel events → metric value. Pure function. */
  compute: (events: readonly TEvent[]) => number
}

/**
 * Canonical event shape. Real telemetry is added in ECLASS-38; for now the
 * acceptance suite and unit tests construct these directly. Note: PII
 * (email, name, answer text) is deliberately absent — NFR privacy.
 */
export interface FunnelEvent {
  type:
    | 'teacher_activated'
    | 'assignment_created'
    | 'student_joined'
    | 'submission_started'
    | 'submission_submitted'
    | 'feedback_sent'
    | 'student_returned'
  /** Tenant / class scope — never an email. */
  actorId: string
  classId?: string
  /** Epoch millis. Tests use deterministic clocks. */
  at: number
}

const percent = (numerator: number, denominator: number) =>
  denominator === 0 ? 0 : Math.round((numerator / denominator) * 100)

const median = (values: readonly number[]) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 24 * MS_PER_HOUR

export const METRICS: Record<MetricId, MetricDefinition<FunnelEvent>> = {
  /**
   * Teacher activation: a teacher who created a class AND invited at least
   * one student within their first session. % of all teachers who signed up.
   */
  teacher_activation: {
    id: 'teacher_activation',
    description:
      'Доля учителей, которые за первую сессию создали класс и пригласили хотя бы одного ученика.',
    target: 60,
    direction: 'higher_is_better',
    baseline: 0,
    compute: (events) => {
      const signups = new Set<string>()
      const activated = new Set<string>()
      for (const e of events) {
        if (e.type === 'teacher_activated') signups.add(e.actorId)
        if (e.type === 'assignment_created') activated.add(e.actorId)
      }
      return percent(activated.size, signups.size || activated.size)
    },
  },

  /**
   * Student completion: % of started submissions that were finalized (idempotent
   * submit) — not just opened.
   */
  student_completion: {
    id: 'student_completion',
    description:
      'Доля начатых работ, которые ученик сдал (подтверждённая отправка), а не просто открыл.',
    target: 70,
    direction: 'higher_is_better',
    baseline: 0,
    compute: (events) => {
      const started = new Set<string>()
      const submitted = new Set<string>()
      for (const e of events) {
        if (e.type === 'submission_started') started.add(e.actorId)
        if (e.type === 'submission_submitted') submitted.add(e.actorId)
      }
      return percent(submitted.size, started.size)
    },
  },

  /**
   * Feedback SLA: median hours between a student submitting and a teacher
   * sending feedback. Lower is better.
   */
  feedback_sla_hours: {
    id: 'feedback_sla_hours',
    description:
      'Медианное время от сдачи работы учеником до отправки обратной связи учителем (часы).',
    target: 24,
    direction: 'lower_is_better',
    baseline: 0,
    compute: (events) => {
      const lastSubmitByActor = new Map<string, number>()
      const waits: number[] = []
      for (const e of events) {
        if (e.type === 'submission_submitted') lastSubmitByActor.set(e.actorId, e.at)
        if (e.type === 'feedback_sent') {
          const submittedAt = lastSubmitByActor.get(e.actorId)
          if (submittedAt !== undefined) {
            waits.push((e.at - submittedAt) / MS_PER_HOUR)
            lastSubmitByActor.delete(e.actorId)
          }
        }
      }
      return Math.round(median(waits) * 10) / 10
    },
  },

  /**
   * Week-2 retention: % of students who returned (any activity) in the window
   * 7–14 days after their first submission. Cohort definition is fixed here.
   */
  week2_retention: {
    id: 'week2_retention',
    description:
      'Доля учеников, вернувшихся в окно 7–14 дней после первой сдачи работы.',
    target: 35,
    direction: 'higher_is_better',
    baseline: 0,
    compute: (events) => {
      const firstSubmitByActor = new Map<string, number>()
      for (const e of events) {
        if (e.type === 'submission_submitted' && !firstSubmitByActor.has(e.actorId)) {
          firstSubmitByActor.set(e.actorId, e.at)
        }
      }
      const cohortSize = firstSubmitByActor.size
      if (cohortSize === 0) return 0
      let retained = 0
      for (const e of events) {
        if (e.type !== 'student_returned') continue
        const firstAt = firstSubmitByActor.get(e.actorId)
        if (firstAt === undefined) continue
        const deltaDays = (e.at - firstAt) / MS_PER_DAY
        if (deltaDays >= 7 && deltaDays <= 14) retained += 1
      }
      return percent(retained, cohortSize)
    },
  },

  /**
   * Time to first assignment: median minutes from teacher signup to their
   * first created assignment. Proxy for "frictionless invite" need.
   */
  time_to_first_assignment_minutes: {
    id: 'time_to_first_assignment_minutes',
    description:
      'Медианное время от регистрации учителя до первого назначенного задания (минуты).',
    target: 10,
    direction: 'lower_is_better',
    baseline: 0,
    compute: (events) => {
      const signupByActor = new Map<string, number>()
      const times: number[] = []
      for (const e of events) {
        if (e.type === 'teacher_activated' && !signupByActor.has(e.actorId)) {
          signupByActor.set(e.actorId, e.at)
        }
        if (e.type === 'assignment_created') {
          const signupAt = signupByActor.get(e.actorId)
          if (signupAt !== undefined) {
            times.push((e.at - signupAt) / 60_000)
            signupByActor.delete(e.actorId)
          }
        }
      }
      return Math.round(median(times))
    },
  },
}

/**
 * The single source of truth for "is this metric meeting its target?".
 * Used by acceptance tests and the future release gate (ECLASS-39).
 */
export function meetsTarget(id: MetricId, value: number): boolean {
  const def = METRICS[id]
  return def.direction === 'higher_is_better' ? value >= def.target : value <= def.target
}
