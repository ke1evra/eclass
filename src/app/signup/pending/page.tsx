import { resendConfirmAction } from '../../actions'

/**
 * A4 — Email pending (ECLASS-56 Stage C, Figma 13:52). After signup the
 * account is inert until the confirmation link opens; resend is generic (no
 * enumeration). E8-adjacent recovery lives on /login.
 */
export default async function SignupPendingPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; resent?: string; error?: string }>
}) {
  const { email, resent, error } = await searchParams

  return (
    <main className="page-narrow">
      <h1>Подтвердите email</h1>

      {resent ? (
        <p role="status" className="notice">
          Письмо отправлено повторно{email ? ` на ${email}` : ''}. Если оно не пришло — проверьте папку «Спам».
        </p>
      ) : (
        <p>
          Мы отправили письмо со ссылкой подтверждения{email ? ` на ${email}` : ''}. Откройте её, затем войдите.
        </p>
      )}
      {error === 'email_not_configured' ? (
        <p role="alert" className="error">
          Почтовый сервис не настроен — повторная отправка временно недоступна.
        </p>
      ) : null}

      {email ? (
        <form action={resendConfirmAction} className="card form">
          <input type="hidden" name="email" value={email} />
          <button type="submit" className="ghost">
            Отправить письмо ещё раз
          </button>
        </form>
      ) : null}
    </main>
  )
}
