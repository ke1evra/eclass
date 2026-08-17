import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { getPageAuth } from '@/auth/server'
import { createAttemptsService } from '@/attempts/service'

/** T7 — единая очередь ручной проверки (ECLASS-33). */
export default async function ReviewQueuePage() {
  const { actor } = await getPageAuth()
  if (!actor) redirect('/login?notice=auth')
  if (actor.role !== 'teacher') redirect('/student')

  const payload = await getPayload({ config })
  const svc = createAttemptsService(payload)
  const items = await svc.reviewQueue(actor)

  const names = new Map<string, string>()
  if (items.length > 0) {
    const users = await payload.find({
      collection: 'users',
      where: { id: { in: items.map((i) => i.studentId) } },
      limit: 100,
      overrideAccess: true,
      depth: 0,
    })
    for (const u of users.docs) names.set(u.id, (u as { name?: string }).name ?? 'Без имени')
  }

  return (
    <main className="page-narrow">
      <header className="page-header">
        <h1>Проверка работ</h1>
        <Link href="/teacher" className="inline">← Кабинет</Link>
      </header>

      {items.length === 0 ? (
        <p data-testid="empty-queue" className="card">Очередь пуста — всё проверено.</p>
      ) : (
        <ul className="class-list">
          {items.map((i) => (
            <li key={i.id} className="card class-card">
              <Link href={`/teacher/review/${i.id}`} className="class-link">
                <strong>{i.title}</strong>
                <span>
                  {names.get(i.studentId) ?? 'Ученик'} · сдано{' '}
                  {new Date(i.submittedAt).toLocaleString('ru-RU')}
                  {i.pendingManual ? ' · ждёт проверки развёрнутых' : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
