import { USER_NEEDS, METRICS } from '@/metrics/contract'
import type { MetricId } from '@/metrics/contract'

const KPI_ORDER: MetricId[] = [
  'teacher_activation',
  'student_completion',
  'feedback_sla_hours',
  'week2_retention',
  'time_to_first_assignment_minutes',
]

const formatTarget = (id: MetricId): string => {
  const m = METRICS[id]
  if (id === 'feedback_sla_hours') return `≤${m.target} ч`
  if (id === 'time_to_first_assignment_minutes') return `≤${m.target} мин`
  if (m.direction === 'higher_is_better') return `≥${m.target}%`
  return `≤${m.target}`
}

/**
 * /about/mvp — public, machine-checked MVP statement.
 * The acceptance suite (tests/acceptance/critical-flow.spec.ts) asserts that
 * the 5 needs and the KPI targets are present on this page. Keep them in sync
 * with src/metrics/contract.ts — they are rendered FROM the contract.
 */
export default function MvpPage() {
  return (
    <main>
      <h1>MVP scope — Экзамен Класс</h1>
      <p>
        Один предмет (математика), ОГЭ + ЕГЭ. PWA-first. Главный цикл:
        учитель&nbsp;→&nbsp;класс&nbsp;→&nbsp;приглашение&nbsp;→&nbsp;назначение&nbsp;→
        выполнение&nbsp;→&nbsp;проверка&nbsp;→&nbsp;обратная связь&nbsp;→&nbsp;работа над ошибками.
      </p>

      <h2>5 главных потребностей</h2>
      <ul className="needs">
        {USER_NEEDS.map((need) => (
          <li key={need.id}>{need.statement}</li>
        ))}
      </ul>

      <h2>KPI успеха (MVP)</h2>
      <dl className="kpis">
        {KPI_ORDER.map((id) => (
          <div key={id}>
            <dt>{METRICS[id].description}</dt>
            <dd>Target: {formatTarget(id)}</dd>
          </div>
        ))}
      </dl>

      <h2>Что явно не входит в MVP</h2>
      <ul className="needs">
        <li>Native iOS/Android, desktop shell, push-нотификации.</li>
        <li>Кабинет родителя, платежи, видеосвязь, маркетплейс.</li>
        <li>AI-оценка развёрнутых ответов без human-in-the-loop.</li>
        <li>Второй и последующие предметы.</li>
      </ul>
    </main>
  )
}
