# API контракты — ECLASS-10

> Канон — код в `src/api/contracts.ts` (zod-схемы) + `src/api/router.ts`
> (in-memory обработчики). Этот файл — человеческая проекция.

## Принципы

1. **Контракт = тип + валидатор.** Каждый endpoint описан zod-схемой запроса и
   ответа в `CONTRACTS`. Изменение схемы ломает тесты раньше, чем потребителя.
2. **Единая модель ошибок** — RFC 9457 Problem Details (`code`, `title`,
   `status`, `errors`, `requestId`). Потребитель ветвится по стабильному
   `code`, а не по строке.
3. **Privacy by construction.** В response-схемах **нет** полей `email`,
   `answerKey`, `correctAnswer`. Тест `no PII on response shapes` делает это
   явным инвариантом — тихо добавить такое поле нельзя.
4. **Идемпотентность** там, где ретрай опасен: `upsertAnswer` и `submit`
   требуют `idempotencyKey` (8–128 символов). Один ключ → один результат.
5. **Явные получатели.** `createAssignment` требует непустой `recipientIds` —
   никакого неявного «всем» (security default, ECLASS-24).

## Контрактная поверхность (8 endpoints критического slice)

| Endpoint | Метод | Путь | Ошибка-коды |
|---|---|---|---|
| createClass | POST | `/api/classes` | validation_error, forbidden |
| joinClass | POST | `/api/classes/join` | validation_error, not_found, conflict |
| listContent | GET | `/api/content` | validation_error, forbidden |
| createAssignment | POST | `/api/assignments` | validation_error, forbidden, not_found |
| upsertAnswer | POST | `/api/answers` | validation_error, forbidden, not_found, conflict |
| submit | POST | `/api/submissions/:id/submit` | forbidden, not_found, conflict, invalid_transition |
| review | POST | `/api/submissions/:id/review` | forbidden, not_found, conflict, validation_error |
| createComment | POST | `/api/submissions/:id/comments` | forbidden, not_found, validation_error |

## Слои

```
HTTP (Next.js route handler)
  └─ src/api/router.ts        ← парсит zod, вызывает authorize(), гоняет lifecycle
       ├─ src/api/contracts.ts ← типы + валидаторы + error model
       └─ src/domain/*         ← чистые бизнес-правила
```

`router.ts` намеренно framework-agnostic (возвращает `{ status, body }`),
чтобы критический slice тестировался без HTTP и БД. Route handlers в
`src/app/api/*` станут тонкими обёртками вокруг этих функций в P1–P5.

## Derived, не client-supplied

- `review.totalScore` **всегда** сумма `criterionScores` на сервере. В request
  его нет; если клиент пришлёт — поле будет проигнорировано (Zod его не
  содержит). Snapshot рубрики и `maxScore` — в ECLASS-34.
- `listContent` возвращает `QuestionSummary` без ответов: ответ/ключ ответа
  живут в отдельных защищённых контекстах (проверка, разбор).

## Что дальше

- `ECLASS-11`: CI запускает `tsc + lint + unit + integration` на каждый merge;
  contract tests — обязательная часть gate.
- `ECLASS-30`: настоящая idempotency-store для `submit`/`upsertAnswer`.
- `ECLASS-38`: audit-event пайплайн (`AuditEvent` из контракта).
