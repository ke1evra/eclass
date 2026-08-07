import { getStudentWorkspaceService } from '@/students/server'
import { cookies } from 'next/headers'

/**
 * /student — student shell (ECLASS-16).
 *
 * SECURITY (CB-4 / ECLASS-51): the student identity is resolved ONLY from the
 * server-side session (cookie), NEVER from a query parameter. Until the
 * session helper lands, this page renders an explicit "authentication
 * required" state instead of accepting an identity from the URL — there is no
 * path by which a caller can read another student's data here.
 *
 * Accessibility (acceptance: works from 320px and with keyboard):
 *   - semantic landmarks (main, section), focusable content, no mouse-only gestures;
 *   - responsive layout via the existing globals.css max-width.
 */
export default async function StudentPage() {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get('session')

  // TODO(CB-4/ECLASS-51): replace this stub with a real getSession() that
  // resolves the authenticated student id from the session. Until then, NO
  // identity is trusted and the page renders the auth-required state.
  const studentId = sessionCookie ? null : null

  if (!studentId) {
    return (
      <main>
        <h1>Кабинет ученика</h1>
        <p role="alert">
          Для доступа к кабинету нужно войти по приглашению учителя. Код приглашения
          нельзя получить из адресной строки — он выдаётся учителем.
        </p>
      </main>
    )
  }

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
