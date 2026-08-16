import { joinAction } from '../actions'

/**
 * A7 — Student invite (ECLASS-56 Stage C, Figma 14:46). The invite code is
 * the only trust anchor: it creates the student account AND the class
 * membership in one atomic transaction (ECLASS-57). E5 recovery states tell
 * the student to ask the teacher for a fresh code.
 */
const ERRORS: Record<string, string> = {
  invite_invalid: 'Код не найден. Проверьте его у учителя.',
  invite_expired: 'Срок действия кода истёк. Попросите учителя новый код.',
  invite_revoked: 'Код отозван учителем. Попросите новый.',
  invite_used: 'Код уже использован. Попросите учителя новый код.',
  already_member: 'Вы уже в этом классе.',
  conflict: 'Такой логин уже занят. Выберите другой.',
  validation_error: 'Заполните все поля; пароль — минимум 8 символов.',
  error: 'Сервис недоступен, попробуйте ещё раз.',
}

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; login?: string; error?: string }>
}) {
  const { code, login, error } = await searchParams

  return (
    <main className="page-narrow">
      <h1>Вход в класс по коду</h1>
      <p>Учитель дал вам код класса? Заполните форму — вы сразу попадёте в кабинет.</p>

      {error && ERRORS[error] ? (
        <p role="alert" className="error">
          {ERRORS[error]}
        </p>
      ) : null}

      <form action={joinAction} className="card form">
        <label htmlFor="code">Код класса</label>
        <input
          id="code"
          name="code"
          required
          defaultValue={code ?? ''}
          autoCapitalize="characters"
          autoComplete="one-time-code"
        />

        <label htmlFor="displayName">Как вас зовут (имя в классе)</label>
        <input id="displayName" name="displayName" required maxLength={120} autoComplete="name" />

        <label htmlFor="login">Логин (email) — для входа с других устройств</label>
        <input id="login" name="login" type="email" required defaultValue={login ?? ''} autoComplete="email" />

        <label htmlFor="password">Пароль (минимум 8 символов)</label>
        <input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" />

        <button type="submit">Войти в класс</button>
      </form>
    </main>
  )
}
