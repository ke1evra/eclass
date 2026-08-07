# Аутентификация учителя — ECLASS-13

> Канон: `src/auth/service.ts`. Этот файл — проекция для разработчиков и
> следующих задач P1.

## Принципы

1. **Чистый сервис, injected store.** `createAuthService({ store, clock, ... })`
   принимает `AuthStore` (in-memory в тестах, Payload в проде) и `Clock`
   (детерминированный в тестах). Сервис не знает ни про HTTP, ни про БД.
2. **Пароль никогда не хранится в plaintext.** Хэш (salted SHA-256 в MVP;
   argon2 — в `ECLASS-17` hardening) + `timingSafeEqual` для сравнения.
3. **Сессии revocable.** Каждая сессия имеет `id`, `expiresAt`, `revoked`.
   Cookie имеет secure-форму: `httpOnly + secure + sameSite=lax`.
4. **Anti-enumeration.** Неизвестный пользователь и неверный пароль дают
   одинаковый код `invalid_credentials` — нельзя понять, существует ли email.
5. **Email gate.** Логин невозможен до `confirmEmail` (`email_not_confirmed`).
6. **Rate limit.** После `maxFailedAttempts` (по умолчанию 5) повторные неудачи
   для того же email дают `rate_limited`.

## Cookie-форма (acceptance)

```ts
{
  httpOnly: true,   // недоступен из JS
  secure: true,     // только по HTTPS
  sameSite: 'lax',  // защита от CSRF при сохранении top-level навигации
  maxAgeMs: sessionTtlMs,
}
```

## Жизненный цикл

```
signup (email+password) → user { emailConfirmed: false }
  → confirmEmail(userId)          ← email-confirmation flow (ECLASS-13 stub)
  → login → session + secure cookie
  → authenticate(sessionId) → { userId, role: 'teacher' }
  → logout → revokeSession
```

## Соответствие критериям ECLASS-13

- ✅ Email подтверждён до создания приглашений: `login` требует
  `emailConfirmed`; приглашения (ECLASS-15) будут проверять аутентифицированного
  учителя.
- ✅ Сессии revocable; cookie secure/httpOnly/sameSite.
- ✅ После входа открывается пустой teacher workspace с явным следующим шагом
  (UI — `ECLASS-16`/workspace; контракт готов: `authenticate` возвращает role).

## Что дальше

- `ECLASS-14`: классы и состав (использует `authenticate`).
- `ECLASS-15`: приглашение ученика (требует подтверждённого учителя).
- `ECLASS-17`: hardening — argon2, ротация сессий, audit входов.
