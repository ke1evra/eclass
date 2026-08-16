# Матрица Requirement → Design → Test → CI artifact — ECLASS-60

> Living-документ. Каждое критическое приёмочное требование связано с макетом
> (стабильное имя Figma-фрейма), конкретным тестом и CI job, который его
> прогоняет. Статусы доказательства:
> **Implemented → Integrated → Acceptance proven → Released**.
> `test.skip`/`test.todo` и mock store **не считаются** доказательством (см.
> `tests/integration/compliance/skip-registry.test.ts`).
>
> Статус считается per-boundary (route/приложение), а не per-service: unit
> домена не повышает статус, пока граница Payload/Mongo не покрыта.

## Легенда статусов

| Статус | Что означает |
|---|---|
| Implemented | Код написан, unit покрывает логику |
| Integrated | Работает с реальной границей (Payload/MongoDB, route handler), не mock |
| Acceptance proven | E2E/интеграция проходит в CI, артефакт приложен |
| Released | Прошёл release-candidate gate (2× E2E, audit, a11y) |

## Матрица

| Requirement ID | Design (Figma-фреймы) | Задача | Тест (file:test) | CI job / artifact | Статус |
|---|---|---|---|---|---|
| **R1** CI блокирует merge при test/lint/typecheck/build/a11y failure | — | ECLASS-11/60 | ci.yml шаги + `tests/integration/compliance/skip-registry.test.ts` | `quality` job, build step | Integrated |
| **R2** Запрет незарегистрированных skip/todo в critical E2E | — | ECLASS-60 | `skip-registry.test.ts` ("every test.skip in acceptance is registered") | `quality` job (unit) | Acceptance proven |
| **R3** Unit не заменяет integration; integration = реальная Payload/MongoDB | — | ECLASS-56 | `tests/integration/classes/class-routes.test.ts` (второе Mongo-подключение читает данные), `tests/integration/auth/*` против replica set | `quality` job, Mongo service | Acceptance proven (локально; CI run ожидает пуша) |
| **R4** Tenant isolation: ни один отрицательный кейс не возвращает чужие данные | T1–T3, S1–S2, E2, E7 | ECLASS-17/50/56 | `tenant-isolation.test.ts` (домен) + `class-routes.test.ts` "IDOR: teacher B…" (Mongo route) | `quality` job | Acceptance proven |
| **R5** Invite replay защищён; атомарное принятие (submit-идемпотентность → R16) | T3, A7, A8, S1, E5 | ECLASS-15/57 | `tests/integration/classes/atomic-join.test.ts` (parallel accept, rollback, replay, unique index) + `p1-identity-flow.spec.ts` (E5 replay) | `quality` + `e2e` | Acceptance proven |
| **R6** Аудит содержит actor/action/resource/time без PII | — | ECLASS-17 | `tenant-isolation.test.ts` "audit PII hygiene" | `quality` job | Acceptance proven |
| **R7** Identity только из сессии, не из URL/body | A1–A4, A6–A8 | ECLASS-13/51/56 | `class-routes.test.ts` "no cookie / forged cookie → 401; actor never comes from the body" + `payload-auth-authority.test.ts` | `quality` job | Acceptance proven |
| **R8** Publication gate нельзя обойти; versions хранятся в БД | T4 (downstream) | ECLASS-58 | `tests/unit/content/versioning.test.ts` + (план) Mongo persistence | `quality` job | Implemented |
| **R9** Release-candidate дважды прогоняет критический поток | Journey Map | ECLASS-11 | `release-candidate.yml` (E2E x2) | `release-e2e-twice` job | Integrated (P1-поток зелёный; P3+ фичи GATED) |
| **R10** Axe serious/critical = 0 на критических страницах | все публичные + T1, S1 | ECLASS-53/60 | `tests/acceptance/accessibility.spec.ts` (/, /about/mvp, /student, /login, /signup, /signup/pending, /join) + axe в `p1-identity-flow.spec.ts` (T1, S1) | `e2e` job | Acceptance proven |
| **R11** npm audit high=0/critical=0 | — | ECLASS-55 | CI `npm audit` шаг + локально `npm audit --omit=dev` | `quality` job | Acceptance proven |
| **R12** Keyboard-only критический поток | A2 (Login) | ECLASS-13/60 | `p1-identity-flow.spec.ts` "keyboard-only: the critical login flow…" | `e2e` job | Acceptance proven (login; расширяется с P3+) |
| **R13** Rate limit в общем хранилище: sliding window, fail-closed, без enumeration | A2, A3, A5, E4 | ECLASS-59 | `tests/integration/auth/rate-limit.test.ts` (multi-instance, race, 429+Retry-After, privacy, fail-closed) | `quality` job | Acceptance proven (локально; CI run ожидает пуша) |
| **R14** Критический P1-поток A1→T3→A7→S1 без skip | Journey Map, A1–A8, T1–T3, S1–S2 | ECLASS-2/56 | `tests/acceptance/p1-identity-flow.spec.ts` (без skip; mobile 390px) | `e2e` job | Acceptance proven |
| **R15** Перезапуск процесса не теряет данные (сессии и классы) | — | ECLASS-65/56/14 | `cross-process-restart.test.ts` (создатель завершается, свежий процесс читает) | `quality` job | Acceptance proven |
| **R16** Submit идемпотентен и устойчив к обрыву сети | S5, S6, E6 | ECLASS-29 | (план) Mongo transaction + network emulation | `e2e` job | Pending (ECLASS-29) |

## Правила доказательства (CI-enforced)

1. **Никаких skip без регистрации.** `skip-registry.test.ts` сканирует
   `tests/acceptance/**` и падает на любой `.skip`/`.todo` (через любой алиас),
   причина которого не в `ALLOWED_SKIPS`. Каждая регистрация должна называть
   разблокирующую задачу `ECLASS-N`.
2. **Unit ≠ integration.** Integration-тесты идут с реальной границей (Mongo/
   Payload route handler), а не mock-store. Mock-store unit-тесты остаются для
   быстрой обратной связи, но не доказывают persistence.
3. **Скриншот без assertion = не доказательство.** E2E assertions проверяют
   состояние, а не только визуал.
4. **Security = negative tests.** Каждый security-инвариант имеет отрицательный
   тест (IDOR, role escalation, replay, enumeration, forged cookie).
5. **Concurrency = parallel test + Mongo invariant.** Атомарные операции
   (ECLASS-57) проверяются параллельным тестом против replica set.

## CI artifacts (что прикрепляется к прогону)

- coverage report (`coverage/`)
- Playwright trace + HTML report (`playwright-report/`, `test-results/`)
- (план) Payload indexes/migrations выкладка
- (план) npm audit summary

## Что добавляют последующие задачи

- ~~ECLASS-56: переводит R3/R4/R7/R8 из Implemented → Integrated~~ — выполнено
  (R3/R4/R7 → Acceptance proven; R8 остаётся Implemented до ECLASS-58)
- ~~ECLASS-57: переводит R5 → Acceptance proven~~ — выполнено
- ECLASS-58: закрывает R8 (publication gate в Mongo)
- ~~ECLASS-59: персистентный rate-limit~~ — выполнено (R13)
- ECLASS-29: закрывает R16 (идемпотентная сдача)
- ECLASS-23+: каждая P3-фича добавляет свои строки (T4–T8, S3–S8) по этому же
  шаблону Design→Test→CI
