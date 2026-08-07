# Tenant isolation и защита auth-контуров — ECLASS-17

> Канон: `src/security/audit.ts`, `tests/integration/security/tenant-isolation.test.ts`.
> Этот файл — проекция security-свойств P1.

## Security-инварианты (доказаны тестом)

Security suite (`tests/integration/security/tenant-isolation.test.ts`, 11 кейсов)
прогоняет реальную матрицу атак через настоящие сервисы P1:

| Класс атаки | Кейс | Результат |
|---|---|---|
| **IDOR** | teacher B читает/переименовывает/архивирует/роутит класс teacher A | `not_found` — данные не возвращены |
| **IDOR** | teacher B добавляет ученика в класс teacher A | `not_found` |
| **IDOR** | teacher B создаёт invite для класса teacher A | `not_found` |
| **Role escalation** | student действует как teacher (create class) | domain policy → `forbidden` |
| **Invite replay** | второй ученик по уже использованному коду | `invite_used` |
| **Brute force** | 3+ неудачных login → rate limit | `rate_limited` |
| **Enumeration** | unknown user vs wrong password | одинаковый `invalid_credentials` |
| **Student self-only** | student B читает профиль student A | `not_found` |
| **Audit PII** | reason с email → redacted; тип не имеет email/name/answer | PII не попадает |

## Принцип защиты

1. **Server-side policy везде.** Каждый сервис делегирует в `authorize()`
   (ECLASS-9). Чужой ресурс → `not_found` (существование не утекает), роль-
   мэтч → `forbidden`. Это не middleware-фильтр, а вызов в каждой мутации.
2. **Privacy by construction.** Profile/response-шейпы не имеют PII-полей
   (ECLASS-10/16). Audit-тип `AuditEntry` не имеет `email`/`name`/`answerText`.
3. **Replay protection.** Invite — single-use с `markUsed`. Submit —
   идемпотентный по `idempotencyKey` (ECLASS-10/30).
4. **Anti-enumeration.** Login возвращает один код для «нет пользователя» и
   «неверный пароль»; unknown invite-код → `invite_invalid` (как expired).
5. **Rate limit.** Per-email счётчик неудачных login; `maxFailedAttempts`
   блокирует дальнейшие попытки.

## Audit trail

`createAuditRecorder(sink, clock).record({...})` — единая точка для всех
security-relevant событий. Каждая запись:

```
{ actorId, actorRole, action, resourceType, resourceId, at, outcome, reason?, requestId? }
```

- `actorId` — opaque tenant-scoped id, **никогда** email.
- `reason` проходит через `redactPii` перед хранением (вторая линия обороны).
- `outcome: 'denied'` — security-ревью смотрит в том числе на отказы.

## Соответствие критериям ECLASS-17

- ✅ Ни один отрицательный кейс не возвращает чужие данные (11/11 тестов).
- ✅ Повтор приглашения защищён (`invite_used`); submit защищён идемпотентным
  ключом (контракт ECLASS-10, реализация ECLASS-30).
- ✅ Аудит содержит actor/action/resource/time без PII payload (`AuditEntry`
  тип + `redactPii` + тест на отсутствие email/name/answerText).

## Что дальше

- `ECLASS-39` (release gate): OWASP/IDOR suite как failing gate в pipeline,
  WCAG/perf/upload-abuse/chaos-retries.
- `ECLASS-38`: настоящий audit-pipeline (privacy-safe events, dashboards).
