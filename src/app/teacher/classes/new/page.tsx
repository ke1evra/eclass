import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getPageAuth } from '@/auth/server'
import { listSubjectVersions } from '@/content/catalog'
import { createClassAction } from '../../../actions'

/**
 * T2 — Create class (ECLASS-56 Stage C, Figma 15:18). Subject+exam comes from
 * the versioned catalog — no free text, so class identity is reproducible.
 */
export default async function NewClassPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { actor, sessionState } = await getPageAuth()
  if (!actor) redirect(sessionState === 'dead' ? '/login?notice=expired' : '/login?notice=auth')
  if (actor.role !== 'teacher') redirect('/student')
  const { error } = await searchParams

  return (
    <main className="page-narrow">
      <h1>Новый класс</h1>

      {error === 'validation_error' ? (
        <p role="alert" className="error">
          Укажите название и предмет.
        </p>
      ) : error ? (
        <p role="alert" className="error">
          Не удалось создать класс, попробуйте ещё раз.
        </p>
      ) : null}

      <form action={createClassAction} className="card form">
        <label htmlFor="name">Название класса</label>
        <input id="name" name="name" required maxLength={120} placeholder="Например: 9А, математика" />

        <label htmlFor="subjectVersionId">Предмет и экзамен</label>
        <select id="subjectVersionId" name="subjectVersionId" required>
          {listSubjectVersions().map((v) => (
            <option key={v.id} value={v.id}>
              {v.subject} · {v.exam.toUpperCase()} · {v.academicYear}
            </option>
          ))}
        </select>

        <button type="submit">Создать</button>
      </form>

      <p>
        <Link href="/teacher" className="inline">
          ← К классам
        </Link>
      </p>
    </main>
  )
}
