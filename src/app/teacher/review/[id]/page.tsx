import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { getPageAuth } from '@/auth/server'
import { createAttemptsService } from '@/attempts/service'
import {
  commentAction,
  finalizeWorkAction,
  remediationAction,
  scoreAnswerAction,
} from '../../../actions-works'

/**
 * T7 — проверка сдачи (ECLASS-34/35): ответы ученика, автопроверенные баллы,
 * рубрики для развёрнутых, комменты (в т.ч. внутренние), финализация и
 * генерация работы над ошибками (ECLASS-36).
 */
export default async function ReviewAttemptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ remediation?: string }>
}) {
  const { actor } = await getPageAuth()
  if (!actor || actor.role !== 'teacher') redirect('/login?notice=auth')
  const { id } = await params
  const { remediation } = await searchParams

  const payload = await getPayload({ config })
  const svc = createAttemptsService(payload)
  const view = await svc.teacherView(actor, id)
  if (!view.ok) notFound()
  const { attempt, snapshot, studentAnswers } = view

  const studentRes = await payload.find({
    collection: 'users',
    where: { id: { equals: attempt.studentId } },
    limit: 1,
    overrideAccess: true,
  })
  const studentName = (studentRes.docs[0] as { name?: string } | undefined)?.name ?? 'Ученик'

  const scoresByCode = new Map((attempt.scores ?? []).map((s) => [s.code, s]))
  const autoTotal = (attempt.scores ?? []).reduce((sum, s) => sum + (s.auto ?? 0), 0)
  const canFinalize = attempt.status === 'submitted'
  const needsRubric = snapshot.filter((q) => q.type === 'extended-text' && scoresByCode.get(q.code)?.manual == null)

  return (
    <main className="page">
      <header className="page-header">
        <h1>{attempt.title}</h1>
        <Link href="/teacher/review" className="inline">← Очередь</Link>
      </header>
      <p>
        {studentName} · статус: <strong>{attempt.status === 'checked' ? 'проверено' : attempt.status === 'submitted' ? 'сдано' : attempt.status}</strong>
        {attempt.status === 'checked' ? ` · итог ${attempt.totalScore ?? 0} / ${attempt.maxScore ?? 0}` : ` · автопроверка: ${autoTotal}`}
      </p>
      {remediation === 'created' ? (
        <p role="status" className="notice">Работа над ошибками создана и назначена ученику.</p>
      ) : null}

      <ol className="review-list">
        {snapshot.map((q) => {
          const answer = studentAnswers[q.code]
          const score = scoresByCode.get(q.code)
          return (
            <li key={q.code} className="card review-item">
              <p className="review-stem">{q.stem}</p>
              {q.options && q.options.length > 0 ? (
                <ul>
                  {q.options.map((o) => {
                    const chosen =
                      q.type === 'multiple-choice'
                        ? Array.isArray(answer?.value) && (answer.value as string[]).includes(o.id)
                        : answer?.value === o.id
                    return <li key={o.id} className={chosen ? 'chosen' : undefined}>{chosen ? '◉' : '○'} {o.text}</li>
                  })}
                </ul>
              ) : (
                <blockquote className="answer-box">
                  {typeof answer?.value === 'string' && answer.value.trim() ? answer.value : '— пусто —'}
                </blockquote>
              )}
              <p className="review-score">
                Балл: авто {score?.auto ?? '—'} / ручн {score?.manual ?? '—'} из {q.points}
                {score?.teacherComment ? ` · «${score.teacherComment}»` : ''}
              </p>

              {q.type === 'extended-text' && attempt.status === 'submitted' ? (
                <form action={scoreAnswerAction} className="inline-form">
                  <input type="hidden" name="attemptId" value={id} />
                  <input type="hidden" name="code" value={q.code} />
                  <label className="visually-hidden" htmlFor={`m-${q.code}`}>Балл</label>
                  <input id={`m-${q.code}`} name="manual" type="number" min={0} max={q.points} defaultValue={score?.manual ?? 0} style={{ maxWidth: '5rem' }} />
                  <label className="visually-hidden" htmlFor={`c-${q.code}`}>Комментарий</label>
                  <input id={`c-${q.code}`} name="teacherComment" placeholder="Комментарий по рубрике" />
                  <button type="submit" className="ghost">Оценить</button>
                </form>
              ) : null}
            </li>
          )
        })}
      </ol>

      {canFinalize ? (
        <section className="card">
          {needsRubric.length > 0 ? (
            <p className="error">Сначала оцените развёрнутые ответы ({needsRubric.length} шт.).</p>
          ) : null}
          <form action={finalizeWorkAction} className="inline-form">
            <input type="hidden" name="attemptId" value={id} />
            <button type="submit" disabled={needsRubric.length > 0}>Завершить проверку</button>
          </form>
        </section>
      ) : null}

      {attempt.status === 'checked' ? (
        <section className="card">
          <form action={remediationAction} className="inline-form">
            <input type="hidden" name="attemptId" value={id} />
            <button type="submit" className="ghost">Создать работу над ошибками</button>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="fb" className="card">
        <h2 id="fb">Обратная связь</h2>
        <ul className="comments">
          {(attempt.comments ?? []).map((c, i) => (
            <li key={i}>
              <strong>{c.authorRole === 'teacher' ? 'Учитель' : 'Ученик'}{c.internal ? ' (внутреннее)' : ''}:</strong> {c.body}
            </li>
          ))}
        </ul>
        <form action={commentAction} className="form">
          <input type="hidden" name="attemptId" value={id} />
          <label htmlFor="fb-body">Комментарий ученику</label>
          <textarea id="fb-body" name="body" required rows={2} />
          <label className="checkbox-row"><input type="checkbox" name="internal" /> внутренняя заметка (ученик не увидит)</label>
          <button type="submit" className="ghost">Отправить</button>
        </form>
      </section>
    </main>
  )
}
