# Экзамен Класс

Единая адаптивная платформа для учителей и репетиторов: актуальный банк заданий
по предмету, регистрация учеников, индивидуальные назначения, выполнение в
личном кабинете, автоматическая и ручная проверка, двусторонняя обратная связь
и диагностика прогресса. **PWA-first**, разработка строго по **TDD**.

> Канон проекта живёт в Stakan (Payload), проект `ECLASS`. Этот репозиторий —
> реализация. AI-контекст подтягивается через MCP (`get_project_ai_config`).

## Стек (канон, зафиксирован в ECLASS-8)

- **Next.js 15** (App Router, PWA, Server Components), TypeScript strict.
- **Payload 3** (CMS/бэкенд) + **PostgreSQL** (`@payloadcms/db-postgres`).
- Тесты: **Vitest** (unit/integration) + **Playwright** (acceptance/E2E).
- Один монорепо, один язык (TS) на фронте и бэке.

## Быстрый старт

```bash
cp .env.example .env             # заполнить DATABASE_URI, PAYLOAD_SECRET
npm install
npm run dev                      # http://localhost:3000
```

## Скрипты

| Команда             | Что делает                                              |
|---------------------|---------------------------------------------------------|
| `npm run dev`       | Next.js dev server                                      |
| `npm run typecheck` | `tsc --noEmit`, строгая проверка типов                  |
| `npm run lint`      | ESLint (next + typescript + playwright)                 |
| `npm run build`     | production-сборка (включает lint + typecheck)           |
| `npm test`          | Vitest — unit/integration слой пирамиды тестов          |
| `npm run test:e2e`  | Playwright — acceptance/E2E (продуктовый gate)          |

## Обязательный pre-push чек-лист

> CI прогоняет те же шаги, но локальная проверка перед push экономит круг.
> Ни одно заявление «готово» не делается без вывода этих команд:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # 0 errors, 0 warnings
npm run build       # production-сборка собирается
npm test --coverage # unit + integration + coverage gate
npm run test:e2e    # при изменении acceptance/страниц (требует запущенного dev/build сервера)
```

Все пять — зелёные. Если что-то красное, пушить нельзя.

## Структура

```
src/
  app/                # Next.js App Router (страницы, layout)
  metrics/            # продуктовый контракт метрик (канон KPI)
  payload.config.ts   # конфиг Payload 3 (коллекции добавляются по TDD-задачам)
docs/
  product/            # personas, JTBD, MVP scope, metrics — человеческая проекция
tests/
  acceptance/         # Playwright: критический поток как failing acceptance checklist
migrations/           # миграции БД Payload (позже)
```

## TDD-дисциплина

1. **RED** — сначала failing unit/domain/contract test на бизнес-правило и
   failing component/E2E на пользовательский риск.
2. **GREEN** — минимальная реализация, достаточная для прохождения теста.
3. **REFACTOR** — убрать дубли, сохранить зелёным, проверить authorization,
   идемпотентность, аудит и влияние на миграции.
4. Каждый merge: `typecheck + lint + unit + integration`. Релиз-кандидат и
   критический поток: E2E два последовательных прогона + security/a11y/perf
   gates (`ECLASS-39`).

Полный воркфлоу — в ai-context `tddWorkflow` проекта `ECLASS`.

## Текущий статус

P0 — `ECLASS-8` (этот коммит): зафиксированы MVP-гипотезы, персоны, метрики;
 RED acceptance-чеклист и контракт KPI готовы; GREEN-документация в `docs/product`.
Дальше — `ECLASS-9..12` (доменная модель, API-контракты, CI, правовой контур).
