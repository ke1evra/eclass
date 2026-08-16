/**
 * A4-style pending screen after an A5 reset request (ECLASS-69). Same content
 * for known and unknown emails — no enumeration.
 */
export default async function ResetPendingPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>
}) {
  const { email } = await searchParams

  return (
    <main className="page-narrow">
      <h1>Проверьте почту</h1>
      <p>
        Если аккаунт существует{email ? ` для ${email}` : ''}, мы отправили ссылку для смены
        пароля. Она действует один час. Не пришло письмо — проверьте папку «Спам» или
        запросите ссылку ещё раз.
      </p>
      <p>
        <a href="/reset" className="inline">
          Запросить ссылку ещё раз
        </a>
      </p>
      <p>
        <a href="/login" className="inline">
          ← Ко входу
        </a>
      </p>
    </main>
  )
}
