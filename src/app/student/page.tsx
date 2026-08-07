import { getStudentWorkspaceService } from '@/students/server'
import { getSessionResolver, SESSION_COOKIE } from '@/auth/server'
import { cookies } from 'next/headers'

/**
 * /student — student shell (ECLASS-16, fixed in CB-4 / ECLASS-51).
 *
 * SECURITY: the student identity is resolved ONLY from the server-side session
 * cookie via the session resolver. There is NO path by which a caller can
 * supply an identity through the URL — the page takes no params and trusts
 * nothing but the cookie. A missing/invalid session renders the auth-required
 * state; it never falls back to a default or demo identity.
 *
 * Accessibility: semantic landmarks, focusable content, responsive layout
 * (works from 320px), no mouse-only gestures.
 */
export default async function StudentPage() {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value
  const actor = await getSessionResolver().resolveSession(sessionId)

  // No authenticated student actor → auth-required state. We never read or
  // infer an identity from anywhere else.
  if (!actor || actor.role !== 'student') {
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
  const dashboard = await svc.getDashboard(actor.id)
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
