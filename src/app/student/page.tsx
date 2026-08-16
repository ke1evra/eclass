import { getPageActor } from '@/auth/server'
import { getStudentWorkspaceService } from '@/students/server'
import { logoutAction, updateDisplayNameAction } from '../actions'

/**
 * /student — S1 class joined / S2 task list / A8 profile (ECLASS-56 Stage C,
 * Figma 17:2, 17:12, 14:56).
 *
 * SECURITY: identity comes ONLY from the session cookie (Payload-backed
 * resolver). No query parameter can influence whose workspace renders; a
 * student without a membership sees a recovery state, never someone else's
 * data. Responsive from 320px, keyboard-navigable, semantic landmarks.
 */
export default async function StudentPage() {
  const actor = await getPageActor()

  if (!actor || actor.role !== 'student') {
    return (
      <main className="page-narrow">
        <h1>Кабинет ученика</h1>
        <p role="alert">
          Для доступа в кабинет нужен код класса от учителя. Войдите по коду — имя класса и предмет
          подставятся автоматически.
        </p>
      </main>
    )
  }

  const svc = await getStudentWorkspaceService()
  const dashboard = await svc.getDashboard(actor.id)
  if (!dashboard.ok) {
    return (
      <main className="page-narrow">
        <h1>Кабинет ученика</h1>
        <p role="alert">Класс не найден. Попросите учителя новый код приглашения.</p>
        <form action={logoutAction}>
          <button type="submit" className="ghost">
            Выйти
          </button>
        </form>
      </main>
    )
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>Кабинет ученика</h1>
        <form action={logoutAction}>
          <button type="submit" className="ghost">
            Выйти
          </button>
        </form>
      </header>

      <p>
        {dashboard.profile.subjectName} · {dashboard.profile.examTarget.toUpperCase()} · класс «
        {dashboard.profile.className}»
      </p>

      <section aria-labelledby="next-step" className="card">
        <h2 id="next-step">Что дальше</h2>
        <p role="status">{dashboard.nextStep.message}</p>
      </section>

      <section aria-labelledby="assignments" className="card">
        <h2 id="assignments">Мои работы</h2>
        {dashboard.assignments.length === 0 ? (
          <p data-testid="empty-state">Пока ничего не задано.</p>
        ) : (
          <ul>
            {dashboard.assignments.map((a) => (
              <li key={a.id}>
                <a href={`/student/work/${a.id}`}>{a.title}</a> <span>({a.status})</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="profile" className="card">
        <h2 id="profile">Профиль</h2>
        <form action={updateDisplayNameAction} className="inline-form">
          <label htmlFor="displayName" className="visually-hidden">
            Отображаемое имя
          </label>
          <input
            id="displayName"
            name="displayName"
            required
            maxLength={120}
            defaultValue={dashboard.profile.displayName ?? ''}
          />
          <button type="submit" className="ghost">
            Сохранить имя
          </button>
        </form>
      </section>
    </main>
  )
}
