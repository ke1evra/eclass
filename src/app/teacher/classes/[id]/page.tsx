import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { getPageAuth } from '@/auth/server'
import { getClassServices } from '@/classes/server'
import { findSubjectVersion } from '@/content/catalog'
import { archiveClassAction, createInviteAction, logoutAction, renameClassAction } from '../../../actions'
import { listForClass } from '@/assignments/service'

/**
 * T3 — Class detail: invite + roster (ECLASS-56 Stage C, Figma 15:46 +
 * 16:62). The freshly minted invite code is shown once via ?invite= (it is
 * single-use; the teacher copies it into a chat). A foreign teacher gets a
 * plain 404 (E7) — existence of someone else's class never leaks.
 */
export default async function ClassDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ invite?: string; error?: string }>
}) {
  const { actor, sessionState } = await getPageAuth()
  if (!actor) redirect(sessionState === 'dead' ? '/login?notice=expired' : '/login?notice=auth')
  if (actor.role !== 'teacher') redirect('/student')

  const { id } = await params
  const { invite, error } = await searchParams

  const payload = await getPayload({ config })
  const { classService } = getClassServices(payload)
  const cls = await classService.getClass(actor, id)
  if (!cls.ok) notFound()

  const roster = await classService.getRoster(actor, id)
  if (!roster.ok) notFound()

  const users = await payload.find({
    collection: 'users',
    where: { id: { in: roster.studentIds } },
    limit: 200,
    overrideAccess: true,
    depth: 0,
  })

  const works = await listForClass(payload, actor.id, id)

  const subject = findSubjectVersion(cls.class.subjectVersionId)

  return (
    <main className="page">
      <header className="page-header">
        <h1>{cls.class.name}</h1>
        <form action={logoutAction}>
          <button type="submit" className="ghost">
            Выйти
          </button>
        </form>
      </header>
      <p>{subject ? `${subject.subject} · ${subject.exam.toUpperCase()} · ${subject.academicYear}` : cls.class.subjectVersionId}</p>
      <p>
        <Link href="/teacher" className="inline">
          ← К классам
        </Link>
      </p>

      {error ? (
        <p role="alert" className="error">
          Действие не выполнено, попробуйте ещё раз.
        </p>
      ) : null}

      <section aria-labelledby="invite" className="card">
        <h2 id="invite">Пригласить учеников</h2>
        <p>Код одноразовый и действует 24 часа. Ученик вводит его на странице входа по коду.</p>
        {invite ? (
          <p role="status" className="notice" data-testid="invite-code">
            Код класса: <strong>{invite}</strong> — ссылка: /join?code={invite}
          </p>
        ) : null}
        <form action={createInviteAction} className="inline-form">
          <input type="hidden" name="classId" value={id} />
          <button type="submit">Создать код приглашения</button>
        </form>
      </section>

      <section aria-labelledby="roster" className="card">
        <h2 id="roster">Состав класса ({users.docs.length})</h2>
        {users.docs.length === 0 ? (
          <p data-testid="empty-roster">Пока никто не вступил. Создайте код и отправьте его ученикам.</p>
        ) : (
          <ul>
            {users.docs.map((u) => (
              <li key={u.id}>{(u as { name?: string }).name ?? 'Без имени'}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="works" className="card">
        <h2 id="works">Работы класса</h2>
        <p><Link className="button" href={`/teacher/classes/${id}/new-work`}>Собрать новую работу</Link></p>
        {works.length === 0 ? (
          <p data-testid="empty-works">Работ пока нет.</p>
        ) : (
          <table className="works-table">
            <thead><tr><th>Название</th><th>Вопросов</th><th>Сдано</th><th>Срок</th></tr></thead>
            <tbody>
              {works.map((w) => (
                <tr key={w.id}>
                  <td>{w.title}</td>
                  <td>{w.questionCount}</td>
                  <td>{w.submitted} / {w.recipients}</td>
                  <td>{w.dueAt ? new Date(w.dueAt).toLocaleDateString('ru-RU') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="manage" className="card">
        <h2 id="manage">Управление</h2>
        <form action={renameClassAction} className="inline-form">
          <input type="hidden" name="classId" value={id} />
          <label htmlFor="rename" className="visually-hidden">
            Новое название
          </label>
          <input id="rename" name="name" required maxLength={120} defaultValue={cls.class.name} />
          <button type="submit" className="ghost">
            Переименовать
          </button>
        </form>
        <form action={archiveClassAction} className="inline-form">
          <input type="hidden" name="classId" value={id} />
          <button type="submit" className="danger">
            Архивировать класс
          </button>
        </form>
      </section>
    </main>
  )
}
