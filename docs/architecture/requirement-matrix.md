# Матрица Requirement → Test → CI artifact — ECLASS-60

> Living-документ. Каждое критическое приёмочное требование связано с конкретным
> тестом и CI job, который его прогоняет. Статусы доказательства:
> **Implemented → Integrated → Acceptance proven → Released**.
> `test.skip`/`test.todo` и mock store **не считаются** доказательством (см.
> `tests/integration/compliance/skip-registry.test.ts`).

## Легенда статусов

| Статус | Что означает |
|---|---|
| Implemented | Код написан, unit покрывает логику |
| Integrated | Работает с реальной границей (Payload/MongoDB, route handler), не mock |
| Acceptance proven | E2E/интеграция проходит в CI, артефакт приложен |
| Released | Прошёл release-candidate gate (2× E2E, audit, a11y) |

## Матрица

| Requirement ID | Задача | Тест (file:test) | CI job / artifact | Статус |
|---|---|---|---|---|
| **R1** CI блокирует merge при test/lint/typecheck/build/a11y failure | ECLASS-11/60 | ci.yml шаги + `tests/integration/compliance/skip-registry.test.ts` | `quality` job, build step | Integrated |
| **R2** Запрет незарегистрированных skip/todo в critical E2E | ECLASS-60 | `skip-registry.test.ts` ("every test.skip in acceptance is registered") | `quality` job (unit) | Acceptance proven |
| **R3** Unit не заменяет integration; integration = реальная Payload/MongoDB | ECLASS-56 | (план) `tests/integration/mongo/*.test.ts` против Mongo replica set | `quality` job, Mongo service | Implemented (pending Mongo) |
| **R4** Tenant isolation: ни один отрицательный кейс не возвращает чужие данные | ECLASS-17/50 | `tests/integration/security/tenant-isolation.test.ts` | `quality` job | Acceptance proven (in-memory) → Integrated (после Mongo, ECLASS-56) |
| **R5** Invite replay защищён; submit идемпотентен | ECLASS-15/30/57 | `tests/unit/classes/invite-service.test.ts` + (план) Mongo transaction test | `quality` job | Implemented (pending atomic, ECLASS-57) |
| **R6** Аудит содержит actor/action/resource/time без PII | ECLASS-17 | `tenant-isolation.test.ts` "audit PII hygiene" | `quality` job | Acceptance proven |
| **R7** Identity только из сессии, не из URL/body | ECLASS-13/51 | `tests/unit/auth/session.test.ts` + (план) E2E forged cookie | `quality` + `e2e` | Acceptance proven (resolver) → Integrated (после route handlers) |
| **R8** Publication gate нельзя обойти; versions хранятся в БД | ECLASS-58 | `tests/unit/content/versioning.test.ts` + (план) Mongo persistence | `quality` job | Implemented → Integrated (после Mongo) |
| **R9** Release-candidate дважды прогоняет критический поток | ECLASS-11 | `release-candidate.yml` (E2E x2) | `release-e2e-twice` job | Integrated (поток GATED пока фичи не готовы) |
| **R10** Axe serious/critical = 0 на критических страницах | ECLASS-53/60 | `tests/acceptance/accessibility.spec.ts` | `e2e` job | Acceptance proven |
| **R11** npm audit high=0/critical=0 | ECLASS-55 | CI `npm audit` шаг (план) + локально `npm audit --omit=dev` | `quality` job | Acceptance proven |
| **R12** Keyboard-only критический поток | ECLASS-60 | (план) Playwright keyboard-only spec | `e2e` job | Pending |

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

- ECLASS-56: переводит R3/R4/R7/R8 из Implemented → Integrated (реальная Mongo)
- ECLASS-57: переводит R5 → Acceptance proven (atomic transaction)
- ECLASS-58: закрывает R8 (publication gate в Mongo)
- ECLASS-59: персистентный rate-limit (часть R4/R7 на reload)
