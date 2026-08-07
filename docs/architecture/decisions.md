# Архитектурные решения — ECLASS (ADR-индекс)

> Краткие записи (ADR-style). Полные тексты хранятся в Payload
> `decision-records` и дублируются здесь для разработчиков. Принцип: если
> решение не зафиксировано здесь и в Payload — его нет.

## ADR-0001 — PWA-first, native shells после пилота

**Статус:** accepted (07.08.2026, P0).
**Контекст:** целевая аудитория выполняет задания с телефонов со слабой связью;
 поддержание native iOS/Android/desktop параллельно с MVP увеличивает время до
 проверки гипотезы.
**Решение:** MVP — responsive PWA с офлайн-выполнением. Native-оболочки
 выносятся в `ECLASS-43/44` и стартуют только после подтверждения retention.
**Последствия:** один веб-код, одна сборка; нужен сервис-воркер и
 идемпотентная отправка (covered `ECLASS-28..31`).

## ADR-0002 — Один предмет в MVP (математика)

**Статус:** accepted.
**Контекст:** одновременная разработка нескольких предметов размывает фокус и
 задерживает проверку цикла обратной связи.
**Решение:** MVP — математика (ОГЭ + ЕГЭ). Архитектура должна быть
 subject-agnostic (variation points вынесены), но второй предмет подключается
 только в `ECLASS-47`.
**Последствия:** в доменной модели явно присутствует `subject version`;
 question types/scoring/taxonomy не хардкодят предмет.

## ADR-0003 — ФИПИ как канонический источник

**Статус:** accepted.
**Контекст:** отзывы об аналогах указывают на ошибки контента как частую боль.
**Решение:** структура, демоверсии, кодификаторы, спецификации и банк заданий
 берутся из ФИПИ-2026 и **версионируются** по учебному году. Публикация
 невозможна без редакторской валидации (NFR).
**Последствия:** импорт из ФИПИ — отдельный поток (`ECLASS-19`); golden set
 хранится как фикстуры.

## ADR-0004 — Human-in-the-loop для любой автоматизации с непроверяемым результатом

**Статус:** accepted.
**Контекст:** AI-оценка развёрнутых ответов несёт риск неверного итогового
 балла и prompt-injection.
**Решение:** в MVP нет AI в проверке. В будущем (`ECLASS-46`) AI может
 предлагать draft оценки только при прохождении blinded benchmark против двух
 экспертов, с kill-thresholds и обязательным подтверждением учителем. AI никогда
 не публикует итоговый балл сам.

## ADR-0005 — TDD-gate обязателен

**Статус:** accepted.
**Контекст:** продукт работает с несовершеннолетними и экзаменационными
 результатами — цена регрессии высока.
**Решение:** задача не переходит в `done` без автоматических тестов на
 критерии приёмки; критический поток `учитель→ученик→проверка` покрыт E2E.
 CI блокирует merge без typecheck/lint/unit/integration; релиз — без E2E и
 quality gates (`ECLASS-12`, `ECLASS-39`).

## ADR-0006 — Стек: Next.js 15 + TypeScript + Payload 3 + MongoDB

**Статус:** accepted (ECLASS-8, обновлён ECLASS-56/61).
**Контекст:** нужен единый язык фронта/бэка, встроенные роли/аутентификация/
 версионирование контента и быстрый старт TDD.
**Решение:** Next.js 15 (App Router, PWA), TypeScript strict, Payload 3
 (Local API, доступ с `overrideAccess: false`), **MongoDB** (replica set для
 транзакций, ECLASS-57). Тесты — Vitest + Playwright.
**Последствия:** один монорепо; доменные коллекции добавляются инкрементально
 по TDD-задачам P1–P6. Mongo replset обязателен (транзакции).

## ADR-0007 — Единый auth authority: Payload = identity, Sessions = revocable opaque session

**Статус:** accepted (ECLASS-65, 07.08.2026).
**Контекст:** в коде одновременно существовали Payload `Users.auth`, собственный
 `createAuthService` с отдельным passwordHash/scrypt и отдельная `Sessions`
 коллекция. Прямой Payload-backed AuthStore создал бы два источника истины для
 credentials и sessions. Независимая приёмка прямо указала на этот риск до
 начала ECLASS-56.

**Решение — разделение ответственности:**
- **Payload `Users`** — единственный источник identity и проверки пароля.
  Хеш пароля управляется Payload auth; приложение **не читает и не дублирует**
  его в production.
- **`Sessions` коллекция** — единственное хранилище server-side application
  session: opaque id, userId, role-snapshot НЕ используется, expiresAt, revoked.
- **`eclass_session` cookie** — единственный транспорт идентичности; opaque,
  httpOnly+secure+sameSite=lax. Никакого второго cookie/JWT для application
  session.
- **Payload JWT НЕ является application session.** Логин через
  `payload.login()` используется ТОЛЬКО для проверки пароля; возвращённый JWT
  не выставляется как cookie и не читается route handlers.
- **Actor на каждый запрос** определяется так: cookie → `Sessions.find` →
  `Users.findByID` (роль/blocked перечитываются из актуального User, не из
  снапшота сессии) → Actor. Любая сессия, чей user удалён/заблокирован, даёт
  anonymous.
- **`createAuthService`** (CB-5 scrypt + rate limit) остаётся **чистым
  policy/unit-контрактом** для быстрых детерминированных unit-тестов. В
  production path его password-hashing НЕ используется — реальную верификацию
  делает `payload.login()`. Rate-limit логика переносится в production adapter
  (ECLASS-59 — персистентный store), но контракт (`maxFailedAttempts`,
  скользящее окно) сохраняется.

**Целевой flow (production wiring):**
```
signup  → Users.create (role server-set teacher, emailConfirmed=false) [hook]
confirm → Users.update emailConfirmed=true (trusted server, overrideAccess)
login   → payload.login(verify password) + rate-limit check
           → Sessions.insert(opaque id, userId, expiresAt, revoked=false)
           → set eclass_session cookie (opaque id)
resolve → cookie → Sessions.findBySessionId(not revoked, not expired)
           → Users.findByID(= actor source of truth for role/blocked)
           → Actor | anonymous
logout  → Sessions.update revoked=true
```

**Security invariants (тестированные):**
- Actor только из opaque httpOnly cookie.
- Роль/blocked state перечитываются из User на каждом запросе — изменение role
  немедленно влияет на существующую сессию.
- Password hash никогда не возвращается ни adapter, ни route.
- Forged/expired/revoked cookie и unknown user → anonymous.
- Один login создаёт один session record (политика дедупликации — в ECLASS-59).

**Последствия:**
- ECLASS-56 adapter-ы строятся ПО ЭТОЙ схеме: AuthStore не хранит пароль,
  только делегирует `payload.login`; SessionStore = `Sessions` коллекция.
- Никакого второго хеша пароля в production.
- `payload.login` JWT не покидает сервер.

## ADR-0008 — Разделение production/test TypeScript конфигураций

**Статус:** accepted (ECLASS-64).
**Решение:** `tsconfig.json` (production/Next) и `tsconfig.tests.json` (tests +
 vitest/globals). CI имеет два шага: `typecheck` и `typecheck:tests`.
**Рationale:** тесты не должны компилироваться transpile-only (vitest) —
 ошибка типа в тесте даёт ложное доказательство. Production build не включает
 test-only imports.
