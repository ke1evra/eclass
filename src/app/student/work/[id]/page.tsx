import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { getPageAuth } from '@/auth/server'
import { createAttemptsService } from '@/attempts/service'
import { commentAction, saveAnswerAction, submitWorkAction } from '../../../actions-works'

/**
 * Task runner — S3 intro / S4.5 runner / S5 review / S6 submitted / S7
 * feedback (ECLASS-27/28/29/35). One question per screen with a navigator;
 * each answer form posts a server action (autosave on submit-button press —
 * the no-JS baseline; clientVersion = saved count). After submit the work is
 * read-only; after checking the score and the teacher feedback appear.
 */
export default async function RunnerPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await getPageAuth()
  if (!actor) redirect('/login')
  if (actor.role !== 'student') redirect('/teacher')
  const { id } = await params

  const payload = await getPayload({ config })
  const svc = createAttemptsService(payload)
  const view = await svc.studentView(actor, id)
  if (!view.ok) notFound()
  const { attempt, questions, answers, attachmentIds } = view
  const comments = (await svc.commentsFor(actor, id)) ?? []
  const readOnly = attempt.status === 'submitted' || attempt.status === 'checked'
  const versions = new Map<string, number>()

  return (
    <main className="page-narrow">
      <header className="page-header">
        <h1>{attempt.title}</h1>
        <Link href="/student" className="inline">← Кабинет</Link>
      </header>
      <p>
        Статус:{' '}
        <strong data-testid="work-status">
          {attempt.status === 'assigned' && 'не начато'}
          {attempt.status === 'in_progress' && 'в работе'}
          {attempt.status === 'submitted' && 'сдано — ждёт проверки'}
          {attempt.status === 'checked' && `проверено: ${attempt.totalScore ?? 0} / ${attempt.maxScore ?? 0}`}
        </strong>
        {attempt.dueAt ? ` · срок ${new Date(attempt.dueAt).toLocaleString('ru-RU')}` : ''}
      </p>

      <nav aria-label="Навигация по вопросам" className="runner-nav">
        {questions.map((q, i) => (
          <a key={q.code} href={`#q-${q.code}`} className="runner-dot">
            {i + 1}
          </a>
        ))}
      </nav>

      <ol className="runner-list">
        {questions.map((q, i) => {
          const value = answers[q.code]
          const version = (versions.get(q.code) ?? 0) + 1
          versions.set(q.code, version)
          return (
            <li key={q.code} id={`q-${q.code}`} className="card runner-item">
              <p className="review-stem">
                {i + 1}. {q.stem} <span className="bank-meta">[{q.topic} · {q.points} б.]</span>
              </p>

              {readOnly ? (
                <div className="answer-box">
                  {(q.options ?? []).length > 0
                    ? (q.options ?? [])
                        .filter((o) => (q.type === 'multiple-choice' ? Array.isArray(value) && (value as string[]).includes(o.id) : value === o.id))
                        .map((o) => o.text)
                        .join('; ') || '— не отвечено —'
                    : typeof value === 'string' && value.trim()
                      ? value
                      : '— не отвечено —'}
                </div>
              ) : (
                <form action={saveAnswerAction} className="form">
                  <input type="hidden" name="attemptId" value={id} />
                  <input type="hidden" name="code" value={q.code} />
                  <input type="hidden" name="clientVersion" value={version} />

                  {q.type === 'single-choice' ? (
                    <>
                      {q.options.map((o) => (
                        <label key={o.id} className="checkbox-row">
                          <input type="radio" name="value" value={o.id} defaultChecked={value === o.id} /> {o.text}
                        </label>
                      ))}
                      <input type="hidden" name="kind" value="choice-one" />
                    </>
                  ) : q.type === 'multiple-choice' ? (
                    <>
                      {q.options.map((o) => (
                        <label key={o.id} className="checkbox-row">
                          <input type="checkbox" name="value" value={o.id} defaultChecked={Array.isArray(value) && (value as string[]).includes(o.id)} /> {o.text}
                        </label>
                      ))}
                      <input type="hidden" name="kind" value="choice-multi" />
                    </>
                  ) : (
                    <>
                      <textarea name="value" rows={q.type === 'extended-text' ? 8 : 2} defaultValue={typeof value === 'string' ? value : ''} />
                      <input type="hidden" name="kind" value="text" />
                    </>
                  )}
                  <button type="submit" className="ghost">Сохранить ответ</button>
                </form>
              )}
              {(attachmentIds[q.code] ?? []).length > 0 ? (
                <p className="attachments">
                  Вложения: {(attachmentIds[q.code] ?? []).map((aid) => (
                    <a key={aid} href={`/api/attachments/${aid}`} className="inline">файл</a>
                  ))}
                </p>
              ) : null}
            </li>
          )
        })}
      </ol>

      {!readOnly ? (
        <form action={submitWorkAction} className="card">
          <input type="hidden" name="attemptId" value={id} />
          <p>После сдачи ответы изменить нельзя. Неотвеченные вопросы будут оценены как неверные.</p>
          <button type="submit">Сдать работу</button>
        </form>
      ) : null}

      <section aria-labelledby="fb" className="card">
        <h2 id="fb">Обратная связь учителя</h2>
        {comments.length === 0 ? (
          <p>Пока нет сообщений.</p>
        ) : (
          <ul className="comments">
            {comments.map((c, i) => (
              <li key={i}><strong>{c.authorRole === 'teacher' ? 'Учитель' : 'Вы'}:</strong> {c.body}</li>
            ))}
          </ul>
        )}
        <form action={commentAction} className="form">
          <input type="hidden" name="attemptId" value={id} />
          <label htmlFor="q-body">Вопрос учителю</label>
          <textarea id="q-body" name="body" rows={2} required />
          <button type="submit" className="ghost">Отправить</button>
        </form>
      </section>
    </main>
  )
}
