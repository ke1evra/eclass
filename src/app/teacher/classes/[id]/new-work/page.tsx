import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { getPageAuth } from '@/auth/server'
import { getClassServices } from '@/classes/server'
import { listBank } from '@/assignments/service'
import { createWorkAction } from '../../../../actions-works'

/**
 * T4 — Assignment builder (ECLASS-23/24). Bank browser with type filter
 * (links) and search (own GET form — forms never nest), then ONE create form
 * holding title/deadline/recipients/question-cart. No client JS required.
 */
const TYPE_FILTERS: [string, string][] = [
  ['', 'Все типы'],
  ['single-choice', 'Один ответ'],
  ['multiple-choice', 'Несколько'],
  ['short-text', 'Краткий'],
  ['extended-text', 'Развёрнутый'],
]

export default async function NewWorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ type?: string; q?: string; error?: string }>
}) {
  const { actor } = await getPageAuth()
  if (!actor || actor.role !== 'teacher') redirect('/login?notice=auth')
  const { id } = await params
  const { type, q, error } = await searchParams

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

  const bank = await listBank(payload, {
    subjectVersionId: cls.class.subjectVersionId,
    type: (type as 'single-choice' | 'multiple-choice' | 'short-text' | 'extended-text') ?? undefined,
    q,
    limit: 100,
  })

  return (
    <main className="page">
      <header className="page-header">
        <h1>Новая работа · {cls.class.name}</h1>
        <Link href={`/teacher/classes/${id}`} className="inline">← К классу</Link>
      </header>

      {error ? <p role="alert" className="error">Ошибка: {error}. Проверьте название и выбранные вопросы.</p> : null}

      <nav aria-label="Фильтр по типу" className="bank-filters">
        {TYPE_FILTERS.map(([value, label]) => {
          const qs = new URLSearchParams({ ...(value ? { type: value } : {}), ...(q ? { q } : {}) })
          return (
            <a
              key={value || 'all'}
              href={`/teacher/classes/${id}/new-work${qs.toString() ? `?${qs}` : ''}`}
              className={type === value ? 'button' : 'inline'}
              style={{ marginRight: '0.6rem' }}
            >
              {label}
            </a>
          )
        })}
      </nav>
      <form method="get" action={`/teacher/classes/${id}/new-work`} className="inline-form">
        {type ? <input type="hidden" name="type" value={type} /> : null}
        <label htmlFor="q" className="visually-hidden">Поиск</label>
        <input id="q" name="q" defaultValue={q ?? ''} placeholder="Поиск по тексту…" />
        <button type="submit" className="ghost">Найти</button>
      </form>

      <form action={createWorkAction} className="card form">
        <input type="hidden" name="classId" value={id} />
        <input type="hidden" name="subjectVersionId" value={cls.class.subjectVersionId} />

        <label htmlFor="title">Название работы</label>
        <input id="title" name="title" required maxLength={200} placeholder="Например: Домашняя работа №3" />

        <label htmlFor="dueAt">Срок (необязательно)</label>
        <input id="dueAt" name="dueAt" type="datetime-local" />

        <fieldset>
          <legend>Кому назначить (по умолчанию — весь класс)</legend>
          {users.docs.length === 0 ? (
            <p>В классе нет учеников — сначала пригласите их.</p>
          ) : (
            users.docs.map((u) => (
              <label key={u.id} className="checkbox-row">
                <input type="checkbox" name="recipients" value={u.id} defaultChecked />{' '}
                {(u as { name?: string }).name ?? 'Без имени'}
              </label>
            ))
          )}
        </fieldset>

        <h2>Банк заданий ({bank.total})</h2>
        <ul className="bank-list">
          {bank.items.map((question) => (
            <li key={question.code} className="bank-item">
              <label className="bank-label">
                <input type="checkbox" name="questionCodes" value={question.code} />{' '}
                <span className="bank-meta">[{question.topic} · {question.points} б.]</span>{' '}
                {question.stem}
              </label>
              {question.options && question.options.length > 0 ? (
                <ul className="bank-options">
                  {question.options.map((o) => (
                    <li key={o.id}>{o.text}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>

        <button type="submit" disabled={users.docs.length === 0}>Назначить работу</button>
      </form>
    </main>
  )
}
