import Link from 'next/link'
import { getPageActor } from '@/auth/server'
import { logoutAction } from './actions'

/**
 * A1 — Role selection (ECLASS-56 Stage C, Figma 13:5).
 *
 * The entry point: pick teacher (login/signup) or student (join by class
 * code). An already-authenticated visitor sees a direct link into their
 * cabinet instead of the role choice.
 */
export default async function HomePage() {
  const actor = await getPageActor()

  return (
    <main className="page-narrow">
      <h1>Экзамен Класс</h1>
      <p className="lead">Подготовка к ОГЭ и ЕГЭ: классы, работы, проверка и обратная связь.</p>

      {actor ? (
        <section aria-labelledby="continue" className="card">
          <h2 id="continue">Продолжить</h2>
          <p>
            <Link className="button" href={actor.role === 'teacher' ? '/teacher' : '/student'}>
              Открыть кабинет {actor.role === 'teacher' ? 'учителя' : 'ученика'} →
            </Link>
          </p>
          <form action={logoutAction}>
            <button type="submit" className="ghost">
              Выйти
            </button>
          </form>
        </section>
      ) : (
        <section aria-labelledby="role" className="card">
          <h2 id="role">Кто вы?</h2>
          <ul className="role-list">
            <li>
              <Link className="button" href="/login">
                Я учитель — войти
              </Link>
              <p>
                Нет аккаунта?{' '}
                <Link href="/signup" className="inline">
                  Зарегистрироваться
                </Link>
              </p>
            </li>
            <li>
              <Link className="button" href="/join">
                Я ученик — войти по коду класса
              </Link>
              <p>Код выдаёт учитель. Без него кабинет недоступен.</p>
            </li>
          </ul>
        </section>
      )}

      <p>
        <Link href="/about/mvp" className="inline">
          Что входит в MVP →
        </Link>
      </p>
    </main>
  )
}
