# Test pyramid и CI gates — ECLASS-11

> Канон: `vitest.config.ts`, `.github/workflows/ci.yml`,
> `.github/workflows/release-candidate.yml`, `tests/factories.ts`.

## Пирамида тестов

```
                ┌─────────────┐
                │     E2E     │  Playwright, tests/acceptance
                │  (медлен.)  │  критический поток, release-gate x2
                └──────┬──────┘
            ┌──────────┴──────────┐
            │   integration       │  tests/integration, in-memory
            │   contract→domain   │  router без HTTP/БД
            └──────────┬──────────┘
        ┌──────────────┴──────────────┐
        │          unit               │  src/**/*.test.ts + tests/unit
        │  domain, contracts, metrics │  мгновенно, детерминированно
        └─────────────────────────────┘
```

| Слой | Инструмент | Где | Когда |
|---|---|---|---|
| unit | Vitest | `src/**/*.test.ts`, `tests/unit` | каждый merge |
| integration | Vitest | `tests/integration` | каждый merge |
| E2E / acceptance | Playwright | `tests/acceptance` | каждый PR + релиз (x2) |

## Coverage gate

Пороги (`vitest.config.ts`) защищают **критические доменные ветки**, а не
ванитет-метрику:

- lines ≥ 90%, functions ≥ 90%, branches ≥ 85%, statements ≥ 90%.
- Включены только `src/domain`, `src/api`, `src/metrics` — то, где живут
  бизнес-правила. UI/инфраструктура добавляются к покрытию по мере роста.

Падение ниже порога **ломает CI**. Это произошло при настройке (89.38% lines /
79.78% branches) и было исправлено добавлением тестов на непокрытые ветки
router — то есть gate работает.

## Изоляция и детерминизм

- **Фабрики** (`tests/factories.ts`) — единственный источник тестовых данных.
  Детерминированные ID, injectable clock, **никакого production data** и
  никаких PII по умолчанию (NFR privacy).
- **Test DB** — ephemeral Postgres service container в CI
  (`eclass_test`, `DATABASE_URI` в workflow). Production-БД никогда не
  touched.
- `ALLOW_TEST_SEEDING=true` только в CI — прод окружение не принимает
  тестовые фикстуры.

## CI pipelines

### `ci.yml` — каждый push/PR

1. `typecheck` (tsc --noEmit)
2. `lint` (next lint)
3. `test --coverage` (unit + integration, с порогами)
4. `test:e2e` (Playwright, против production-билда)

Любой шаг red → merge заблокирован.

### `release-candidate.yml` — только теги `v*`

Тот же билд проходит **два последовательных E2E-прогона** критического потока
учитель→ученик→проверка. Второй прогон ловит flakiness до релиза, а не после.

## Соответствие критериям приёмки ECLASS-11

- ✅ CI блокирует merge при test/lint/typecheck failure (coverage gate
  доказан на RED-фазе).
- ✅ Тесты изолированы (factories, ephemeral DB) и детерминированы.
- ✅ Критический E2E запускается на каждый релиз-кандидат, дважды.
- (a11y gate добавляется в `ECLASS-39` — release-gate; CI-инфраструктура
  готова принять шаг.)
