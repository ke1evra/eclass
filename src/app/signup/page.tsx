import Link from 'next/link'
import { signupAction } from '../actions'

/**
 * A3 — Teacher signup (ECLASS-56 Stage C, Figma 13:33). Role is always
 * teacher here; student accounts exist only through the invite join (A7).
 */
const ERRORS: Record<string, string> = {
  conflict: 'Аккаунт с таким email уже существует. Войдите или запросите письмо повторно.',
  validation_error: 'Укажите email и пароль не короче 8 символов.',
  email_not_configured: 'Почтовый сервис не настроен — регистрация временно недоступна.',
  error: 'Сервис недоступен, попробуйте ещё раз.',
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; email?: string }>
}) {
  const { error, email } = await searchParams

  return (
    <main className="page-narrow">
      <h1>Регистрация учителя</h1>

      {error && ERRORS[error] ? (
        <p role="alert" className="error">
          {ERRORS[error]}
        </p>
      ) : null}

      <form action={signupAction} className="card form">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required defaultValue={email ?? ''} autoComplete="email" />

        <label htmlFor="password">Пароль (минимум 8 символов)</label>
        <input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" />

        <button type="submit">Создать аккаунт</button>
      </form>

      <p>
        Уже есть аккаунт?{' '}
        <Link href="/login" className="inline">
          Войти
        </Link>
      </p>
    </main>
  )
}
