# План выполнения тестового: Collaborative Todo List

Цель: закрыть весь scope за 1 день, приоритет — обработка конкурентности и edge cases, затем качество кода, затем полнота фич.

---

## Этап 0. Архитектура и подготовка — 30 мин

- Репозиторий `collaborative-todo-list`, монорепо:
  - `/backend`
  - `/frontend`
  - `/docker-compose.yml`
  - `/README.md`
- **Backend:** NestJS, Prisma, PostgreSQL, Socket.IO, JWT
- **Frontend:** Next.js (App Router), React, TypeScript, Socket.IO Client, dnd-kit
- Поднять PostgreSQL через Docker Compose
- Настроить ESLint/Prettier/TypeScript
- Первый рабочий коммит

> SQLite не используем. PostgreSQL лучше соответствует full-stack заданию и не требует смены persistence layer.

---

## Этап 1. Модель данных + авторизация — 60 мин

**Модель:**

- `User`: id, email, name, passwordHash, createdAt
- `List`: id, title, ownerId, version, createdAt, updatedAt
- `ListMember`: listId, userId, role (ADMIN | MEMBER)
- `Task`: id, listId, title, completed, position, createdById, updatedAt, version, lastEditedById, createdAt

**Seed:** `admin@example.com`, `member@example.com` + demo list с задачами.

**Auth:** `POST /auth/login`, JWT используется в HTTP и в WebSocket handshake.

**Проверка:** login → получить JWT → protected endpoint → подключение к WS с JWT.

---

## Этап 2. REST API + бизнес-правила — 60–90 мин

**Lists:** `GET /lists`, `POST /lists`, `DELETE /lists/:id`

**Invitations:**
- `POST /lists/:id/invite` — генерация invite token/link
- `POST /invites/:token/accept`
- Реальную отправку email не делаем, но сам механизм приглашения реализуем полностью (лучше, чем просто пометить в README как нереализованное)

**Tasks:** `GET /lists/:id/tasks`, `POST /lists/:id/tasks`, `PATCH /tasks/:id`, `DELETE /tasks/:id`

**Серверная авторизация (обязательно, не только UI):**
- Только участник списка работает с его задачами
- Admin удаляет любую задачу
- Member удаляет только созданную им
- Completed-задачу нельзя удалить обычным способом
- Admin может удалить completed-задачу с подтверждением

---

## Этап 3. WebSocket foundation — 60 мин

- Socket.IO Gateway, комната `list:{listId}`
- При подключении: JWT auth → проверка membership → join room → отправка состояния
- Событие `list:sync` → payload: `list`, `tasks`, `members`, `version`, `presence`

**Главное правило — DB как source of truth:**

```
WS request → validate → business rules → DB transaction → broadcast
```

(не broadcast → DB)

---

## Этап 4. Realtime CRUD — 45–60 мин

События: `task:create`, `task:update`, `task:delete`, `task:reorder`

Сервер: validate → mutate DB → increment version → broadcast (`task:created`, `task:updated`, `task:deleted`, `task:reordered`)

Новый клиент всегда может получить `list:sync` и восстановить актуальное состояние.

---

## Этап 5. Presence — 30–45 мин

- Presence **не** хранится в PostgreSQL — только в памяти gateway: `listId → userId → { online, editingTaskId }`
- Событие `presence:update`
- UI: `● User A`, `● User B — editing "Task 2"`
- При disconnect: `online = false`
- Debounce на клиенте для focus/editing событий (не спамить WS)

---

## Этап 6. Conflict resolution (concurrent edit) — 60 мин

**Самая важная часть задания.**

Не используем client timestamp как источник истины (часы клиентов ненадёжны). Вместо этого — `Task.version`.

Клиент отправляет: `{ taskId, title, baseVersion }`

Пример:
- Server version = 5
- User A → baseVersion 5, User B → baseVersion 5
- Первый принятый: 5 → 6
- Второй обнаруживает: `baseVersion 5 !== currentVersion 6` → явный конфликт

**Решение:** server-ordered LWW — сервер определяет порядок принятия операций, последнее успешно принятое изменение становится актуальным состоянием. Выбор задокументировать в README.

---

## Этап 7. Delete vs Edit — 30 мин

Сценарий: A редактирует задачу → B удаляет.

- Presence позволяет B видеть "Task is being edited by A"
- Сервер отправляет `conflict:warning`, фронтенд показывает confirmation
- После подтверждения сервер повторно проверяет: существование, права, completed-статус, актуальную версию
- После удаления — `task:deleted` всем клиентам
- **Критично:** offline/replay не должен воскресить удалённую задачу

---

## Этап 8. Concurrent reorder — 45–60 мин

- Fractional/string ordering (не обычные integer indexes), например: `A, M, Z` → вставка между A и M → `A, G, M, Z`
- Каждый reorder: `taskId`, `position`, `operationId`, `baseVersion`
- Не использовать float бездумно — строковый rank или библиотека fractional indexing
- При одинаковом rank — детерминированный порядок (`rank + taskId`)
- Цель: нет дубликатов, нет исчезнувших задач, оба клиента приходят к одинаковому порядку

---

## Этап 9. Offline queue — 60 мин

Frontend:
```ts
type PendingOperation = {
  id: string; // idempotency key
  type: OperationType;
  payload: unknown;
};
```

При disconnect: user action → optimistic UI → offline queue → индикатор "Offline"

При reconnect:
```
connect → list:sync → reconcile local state → replay pending operations
→ server validates each operation → remove successful operations
```

Если операция больше невалидна (задача удалена/нет прав/конфликт) — она не должна бесконечно повторяться.

---

## Этап 10. Frontend — 60–90 мин

```
List
 ├── members/presence
 ├── connection status
 └── tasks
      ├── checkbox
      ├── title / edit
      ├── delete
      └── drag & drop
```

Обязательно: login, list selection, task CRUD, complete, drag & drop, presence, editing indicator, online/offline, conflict confirmation, error states, loading states.

UI аккуратный, но не дизайн-проект.

---

## Этап 11. Тесты — 60–90 мин

Не оставлять "если останется время" — отдельный обязательный этап.

**Unit:** conflict resolution (concurrent update, version mismatch, delete/edit, reorder, permissions)

**Integration/E2E (минимум):** login, create/update/delete task, permissions

**Manual multi-client (два браузера, User A / User B):**
realtime create/update/delete, simultaneous edit, edit+delete, simultaneous reorder, disconnect, offline mutation, reconnect, offline mutation + server-side delete, permissions

---

## Этап 12. Финальная проверка — 30 мин

```
docker compose down -v
docker compose up --build
```

Проверить именно с нуля: lint, typecheck, unit tests, e2e + ручной multi-client сценарий.

---

## Этап 13. README — 30–45 мин

```
# Collaborative Todo List
## Features
## Architecture
## Tech Stack
## Running locally
## Test users
## API
## WebSocket protocol
## Presence
## Conflict resolution
### Concurrent editing
### Delete vs edit
### Concurrent reorder
## Offline mode
## Authorization
## Testing
## Known limitations
## Future improvements
```

Особенно подробно объяснить выбор: server-side ordering/versioning, LWW, fractional indexing, operation IDs/idempotency, WebSocket rooms, in-memory presence, PostgreSQL как source of truth.

---

## Финальный чеклист

**Backend:** NestJS · Prisma · PostgreSQL · JWT · REST · Socket.IO · Guards · DTO validation · business rules · transactions · error handling

**Realtime:** initial sync · realtime CRUD · presence · editing state · concurrent edit · delete/edit conflict · concurrent reorder · deterministic state

**Offline:** connection state · operation queue · operation ID · reconnect · sync · replay · failed operation handling · no resurrection of deleted entities

**Frontend:** auth · lists · tasks · CRUD · complete · DnD · presence · conflict UI · offline indicator · error/loading states

**Quality:** unit tests · integration/e2e · manual two-client scenarios · typecheck · lint · Docker from clean state · README
