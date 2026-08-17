import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { getPageAuth } from '@/auth/server'
import { getClassServices } from '@/classes/server'
import { findSubjectVersion } from '@/content/catalog'
import { logoutAction } from '../actions'

/**
 * T1 — Teacher dashboard (ECLASS-56 Stage C, Figma 15:2) + A6 onboarding
 * (14:32). Empty state (E2) carries the guided first steps: create a class →
 * invite students → wait for joins. A6 is not a separate route; the empty
 * dashboard IS the onboarding checklist.
 */
export default async function TeacherPage() {
  const { actor, sessionState } = await getPageAuth()
  if (!actor) redirect(sessionState === 'dead' ? '/login?notice=expired' : '/login?notice=auth')
  if (actor.role !== 'teacher') redirect('/student')

  const payload = await getPayload({ config })
  const { classService } = getClassServices(payload)
  const classes = await classService.listClasses(actor.id, { includeArchived: false })

  return (
    <main className="page">
      <header className="page-header">
        <h1>Кабинет учителя</h1>
        <form action={logoutAction}>
          <button type="submit" className="ghost">
            Выйти
          </button>
        </form>
      </header>

      {classes.length === 0 ? (
        <section aria-labelledby="onboarding" className="card">
          <h2 id="onboarding">Настройте первый класс</h2>
          <ol className="steps">
            <li>Создайте класс — предмет и экзамен выбираются из списка.</li>
            <li>Пригласите учеников: код или ссылка, действует 24 часа.</li>
            <li>Ученики входят по коду с телефона и появляются в списке класса.</li>
          </ol>
          <p>
            <Link className="button" href="/teacher/classes/new">
              Создать класс
            </Link>{' '}
            <Link className="button ghost" href="/teacher/review">
              Проверка работ
            </Link>
          </p>
        </section>
      ) : (
        <>
          <p>
            <Link className="button" href="/teacher/classes/new">
              Создать класс
            </Link>{' '}
            <Link className="button ghost" href="/teacher/review">
              Проверка работ
            </Link>
          </p>
          <ul className="class-list">
            {classes.map((c) => {
              const subject = findSubjectVersion(c.subjectVersionId)
              return (
                <li key={c.id} className="card class-card">
                  <Link href={`/teacher/classes/${c.id}`} className="class-link">
                    <strong>{c.name}</strong>
                    <span>
                      {subject ? `${subject.subject} · ${subject.exam.toUpperCase()} · ${subject.academicYear}` : c.subjectVersionId}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </main>
  )
}
