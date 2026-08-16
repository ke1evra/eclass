import Link from 'next/link'
import { loginAction } from '../actions'

/**
 * A2 — Login (ECLASS-56 Stage C, Figma 13:17). Shows E4/E8 states from the
 * redirect query: invalid_credentials, email_not_confirmed (recovery via
 * resend), session expired, confirmed.
 */
const ERRORS: Record<string, string> = {
  invalid_credentials: 'Неверный email или пароль.',
  email_not_confirmed: 'Email не подтверждён. Откройте письмо со ссылкой подтверждения.',
  validation_error: 'Заполните email и пароль.',
  error: 'Сервис недоступен, попробуйте ещё раз.',
}

const NOTICES: Record<string, string> = {
  confirmed: 'Email подтверждён. Войдите.',
  expired: 'Сессия истекла — войдите снова.',
  auth: 'Нужен вход учителя.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; email?: string }>
}) {
  const { error, notice, email } = await searchParams

  return (
    <main className="page-narrow">
      <h1>Вход</h1>

      {notice && NOTICES[notice] ? (
        <p role="status" className="notice">
          {NOTICES[notice]}
        </p>
      ) : null}
      {error === 'email_not_confirmed' && email ? (
        <p role="alert" className="error">
          {ERRORS[error]}{' '}
          <Link href={`/signup/pending?email=${encodeURIComponent(email)}`} className="inline">
            Отправить письмо ещё раз
          </Link>
        </p>
      ) : error && ERRORS[error] ? (
        <p role="alert" className="error">
          {ERRORS[error]}
        </p>
      ) : null}

      <form action={loginAction} className="card form">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required defaultValue={email ?? ''} autoComplete="email" />

        <label htmlFor="password">Пароль</label>
        <input id="password" name="password" type="password" required minLength={8} autoComplete="current-password" />

        <button type="submit">Войти</button>
      </form>

      <p>
        <Link href="/reset" className="inline">
          Забыли пароль?
        </Link>
      </p>
      <p>
        Нет аккаунта учителя?{' '}
        <Link href="/signup" className="inline">
          Зарегистрироваться
        </Link>
      </p>
      <p>
        Ученик?{' '}
        <Link href="/join" className="inline">
          Войти по коду класса
        </Link>
      </p>
    </main>
  )
}
