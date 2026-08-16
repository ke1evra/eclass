import { confirmPasswordResetAction } from '../../actions'

/**
 * A5 confirm — set the new password from the emailed one-time link
 * (ECLASS-69). The token lives in the URL exactly once; on success every
 * prior session is revoked and the teacher returns to A2.
 */
const ERRORS: Record<string, string> = {
  validation_error: 'Пароль должен содержать минимум 8 символов.',
  invalid_or_expired: 'Ссылка недействительна или истекла. Запросите новую.',
  error: 'Сервис недоступен, попробуйте ещё раз.',
}

export default async function ResetConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>
}) {
  const { token, error } = await searchParams

  return (
    <main className="page-narrow">
      <h1>Новый пароль</h1>

      {error && ERRORS[error] ? (
        <p role="alert" className="error">
          {ERRORS[error]}{' '}
          {error === 'invalid_or_expired' ? (
            <a href="/reset" className="inline">
              Запросить новую ссылку
            </a>
          ) : null}
        </p>
      ) : null}

      {token ? (
        <form action={confirmPasswordResetAction} className="card form">
          <input type="hidden" name="token" value={token} />
          <label htmlFor="password">Новый пароль (минимум 8 символов)</label>
          <input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" />
          <button type="submit">Сохранить пароль и войти заново</button>
        </form>
      ) : (
        <p role="alert" className="error">
          Ссылка неполная. Запросите новую на странице восстановления доступа.
        </p>
      )}
    </main>
  )
}
