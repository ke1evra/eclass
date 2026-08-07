# Доменная модель — ECLASS-9

> Канон — код в `src/domain/`. Этот файл — человеческая проекция для разработчиков
> и будущих TDD-задач. При расхождении важнее код.

## Принципы

1. **Домен чистый.** Сущности — это TypeScript-типы без ORM и фреймворка. Payload
   коллекции зеркалят эти типы, но домен тестируется без БД.
2. **У каждой сущности есть владелец.** `ownerId` (учитель) у class/assignment;
   `studentId` у submission/answer. Никаких "общих" ресурсов.
3. **Stable IDs.** Внешний ключ — всегда строковый `id`, не порядок в массиве.
4. **Версионирование контента.** `questionVersionId` и `subjectVersionId` tying
   к учебному году ФИПИ (`ECLASS-18/20`).

## Сущности

```
User (teacher | student | admin)
 │
 Class ──owner──▶ User(teacher)
  │  subjectVersionId ──▶ SubjectVersion (ECLASS-18)
  │
  ├── Student (classId)
  │
  └── Assignment ──owner──▶ User(teacher)
       │  questionVersionIds[] ──▶ QuestionVersion
       │  recipientIds[] ──▶ Student      (явные, никакого "всем")
       │
       └── Submission ──studentId──▶ Student
             │  assignmentId ──▶ Assignment
             │
             ├── Answer[] (questionVersionId, payload, clientKey)
             ├── Review (reviewerId, rubric-крафты в ECLASS-34)
             └── Comment[] (authorRole, visibility public|internal)
```

## State machine Submission

```
 assigned ──start──▶ in_progress ──submit──▶ submitted ──check──▶ checked
                                                            ▲           │
                                                            └──reopen───┘
                                                              (audit)
```

| Переход | Функция | Замечания |
|---|---|---|
| assigned → in_progress | `startSubmission` | ученик открыл работу |
| in_progress → submitted | `submitSubmission` | финальная отправка, идемпотентна (ECLASS-30) |
| submitted → checked | `checkSubmission` | проверка завершена (авто + ручная) |
| checked → in_review | `reopenSubmissionForReview` | **единственный** путь назад; требует `reason` и `by`; аудит-событие |
| in_review → checked | `finalizeReview` | повторная финализация после разбора |

Любой недопустимый переход бросает `InvalidTransition` (`code: 'invalid_transition'`,
`from`, `to`). В production-коде, импортирующем этот модуль, запрещённые переходы
**недостижимы** — нет неявного "авто-продвижения".

## Authorization policy

Чистая серверная функция `authorize(actor, action, resource) → Decision`. Два кода
отказа:

- `not_found` — существование не должно утекать. Это то, что видит
  cross-tenant вызывающий (404 на edge). Возврат `forbidden` подтвердил бы, что
  ресурс существует — поэтому чужие ресурсы всегда `not_found`.
- `forbidden` — аутентифицирован, ресурс виден, но действие не разрешено ролью
  (например, студент создаёт assignment).

Правила:
- **Teacher** действует только в своём tenant: `resource.ownerId === actor.id`.
  Чужое → `not_found`.
- **Student** — `read`/`submit` и только `resource.studentId === actor.id`.
  Чужое → `not_found`; создание assignment → `forbidden`.
- **Admin** — только `read` (support). Мутации production-данных — `forbidden`,
  идут через аудит-путь (`ECLASS-38`).

`toHttpStatus(decision)` централизованно мапит решение в HTTP-статус.
