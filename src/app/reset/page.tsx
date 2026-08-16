import Link from 'next/link'
import { requestPasswordResetAction } from '../actions'

/**
 * A5 — Password reset request (ECLASS-69, Figma 14:21). The outcome is always
 * the same screen whether or not the email is registered (anti-enumeration).
 */
export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main className="page-narrow">
      <h1>Восстановление доступа</h1>
      <p>Укажите email — пришлём ссылку для смены пароля. Ссылка действует один час.</p>

      {error === 'validation_error' ? (
        <p role="alert" className="error">
          Укажите корректный email.
        </p>
      ) : null}

      <form action={requestPasswordResetAction} className="card form">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
        <button type="submit">Отправить ссылку</button>
      </form>

      <p>
        <Link href="/login" className="inline">
          ← Вернуться ко входу
        </Link>
      </p>
    </main>
  )
}
