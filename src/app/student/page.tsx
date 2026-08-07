import { getStudentWorkspaceService } from '@/students/server'
import { redirect } from 'next/navigation'

/**
 * /student — student shell (ECLASS-16).
 *
 * Shows the student's subject/exam target, their assigned work, and a clear
 * "next step" hint. A real session resolves `studentId`; for the P1 skeleton we
 * pass a deterministic id so the empty state is observable without auth wiring.
 * Auth integration lands with the route handlers in ECLASS-17.
 *
 * Accessibility (acceptance: works from 320px and with keyboard):
 *   - semantic landmarks (main, nav), focusable links, no mouse-only gestures;
 *   - responsive layout via the existing globals.css max-width.
 */
export default async function StudentPage({
  searchParams,
}: {
  searchParams: Promise<{ studentId?: string }>
}) {
  const { studentId } = await searchParams
  if (!studentId) redirect('/about/mvp')

  const svc = getStudentWorkspaceService()
  const dashboard = await svc.getDashboard(studentId)
  if (!dashboard.ok) {
    return (
      <main>
        <h1>Кабинет ученика</h1>
        <p role="alert">Работы не найдены. Возможно, ссылка устарела — попросите учителя новый код приглашения.</p>
      </main>
    )
  }

  return (
    <main>
      <header>
        <h1>Кабинет ученика</h1>
        <p>
          {dashboard.profile.subjectName} · {dashboard.profile.examTarget.toUpperCase()} · класс «{dashboard.profile.className}»
        </p>
      </header>

      <section aria-labelledby="next-step">
        <h2 id="next-step">Что дальше</h2>
        <p role="status">{dashboard.nextStep.message}</p>
      </section>

      <section aria-labelledby="assignments">
        <h2 id="assignments">Мои работы</h2>
        {dashboard.assignments.length === 0 ? (
          <p data-testid="empty-state">Пока ничего не задано.</p>
        ) : (
          <ul>
            {dashboard.assignments.map((a) => (
              <li key={a.id}>
                <a href={`/student/work/${a.id}`}>{a.title}</a>{' '}
                <span>({a.status})</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
