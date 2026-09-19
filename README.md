# Collaborative Todo List

Monorepo for a realtime collaborative todo list. See [`docs/plan-collaborative-todo-list.md`](docs/plan-collaborative-todo-list.md)
for the full staged implementation plan.

> **Status:** Этапы 0–4 реализованы (архитектура, модель данных + auth, REST API с бизнес-правилами,
> WebSocket foundation, realtime CRUD). Presence UI, conflict-resolution UX, concurrent reorder
> hardening, offline queue, frontend UI и тесты (Этапы 5–13) ещё не реализованы — см.
> `docs/plan-collaborative-todo-list.md` для деталей.

## Tech stack

- **Backend:** NestJS, Prisma, PostgreSQL, Socket.IO, JWT (Passport)
- **Frontend:** Next.js (App Router), React, TypeScript, Socket.IO client, dnd-kit — scaffolded,
  UI not yet built (Этап 10)

## Project structure

```
/backend            NestJS API + WebSocket gateway
/frontend           Next.js app (scaffolded)
/docker-compose.yml PostgreSQL for local dev
```

## Running locally

1. Start PostgreSQL:
   ```
   docker compose up -d postgres
   ```
2. Backend:
   ```
   cd backend
   cp .env.example .env   # already present in dev checkouts
   npm install
   npm run prisma:migrate   # applies migrations
   npm run prisma:seed      # creates demo users + demo list
   npm run start:dev
   ```
   API listens on `http://localhost:3001`.
3. Frontend:
   ```
   cd frontend
   npm install
   npm run dev
   ```
   App listens on `http://localhost:3000`.

## Test users

Seeded by `backend/prisma/seed.ts`:

| Email | Password | Role on "Demo List" |
| --- | --- | --- |
| admin@example.com | password123 | ADMIN (owner) |
| member@example.com | password123 | MEMBER |

## API (implemented)

- `POST /auth/login` — returns `{ accessToken, user }`
- `GET /auth/me` — protected, returns the current user
- `GET /lists` / `POST /lists` / `GET /lists/:id` / `DELETE /lists/:id`
- `POST /lists/:id/invite` (admin only) — creates an invite token/link (no email is sent)
- `POST /invites/:token/accept`
- `GET /lists/:listId/tasks` / `POST /lists/:listId/tasks`
- `PATCH /tasks/:id` — body may include `baseVersion` for optimistic-concurrency checks
- `DELETE /tasks/:id?force=true` — `force` is required to delete a completed task, and only an
  admin may do so

All endpoints (except `/auth/login`) require `Authorization: Bearer <jwt>` and enforce list
membership server-side, not just in the UI.

### Server-side business rules

- Only a member of a list can read/write its tasks.
- An admin (list owner or invited with the `ADMIN` role) can delete any task.
- A member can delete only tasks they created.
- A completed task cannot be deleted the normal way; only an admin can delete it, and only after
  passing `force=true` (the "confirmation").

## WebSocket protocol (implemented)

Connect to the default Socket.IO namespace with the JWT in the handshake:

```js
io(url, { auth: { token: jwtAccessToken } });
```

Authentication runs as a Socket.IO server-side middleware (`server.use`), so an invalid/missing
token rejects the handshake itself (`connect_error`) rather than connecting and then
disconnecting.

Client → server events:

- `list:join { listId }` — validates membership, joins room `list:{listId}`, replies with
  `list:sync`
- `list:leave { listId }`
- `task:create { listId, title }`
- `task:update { taskId, title?, completed?, baseVersion? }`
- `task:delete { taskId, force? }`
- `task:reorder { taskId, beforeId?, afterId?, baseVersion? }`

Server → client events:

- `list:sync { list, tasks, members, version, presence }` — sent to the joining client; a
  reconnecting client always requests this to recover authoritative state
- `presence:update { listId, presence }` — broadcast to the room whenever a member's connection
  count changes
- `task:created / task:updated / task:deleted / task:reordered` — broadcast to the room
- `task:conflict { event, message, code: 'VERSION_CONFLICT', currentTask }` — sent only to the
  requester when `baseVersion` doesn't match the current `Task.version`
- `error { event, status, message }` — sent only to the requester for other validation/permission
  failures

**Server is the source of truth**: every mutation follows `validate → business rules → DB
transaction → broadcast`, never the other way around. `List.version` is incremented on every task
mutation so a client can tell its cached state is stale; `Task.version` is incremented on every
edit and is the basis for the optimistic-concurrency check described above (full conflict-resolution
UX is Этап 6, not yet implemented).

## Data model

`User`, `List`, `ListMember` (role `ADMIN`/`MEMBER`), `Task`, `Invite` — see
`backend/prisma/schema.prisma`. `Task.position` is a fractional-index string (via the
`fractional-indexing` package) rather than an integer, so it can be reordered without reindexing
siblings — this is prepared for Этап 8 (concurrent reorder hardening), which is not yet in scope.

## Known simplifications (to be addressed in later stages per the plan)

- Presence only tracks "who is currently connected"; there's no `editingTaskId` indicator yet
  (Этап 5).
- `task:reorder` computes a fractional key from `beforeId`/`afterId` but doesn't yet implement the
  tie-break/operation-id/idempotency hardening described for Этап 8–9.
- No offline queue/replay yet (Этап 9).
- No frontend UI yet beyond the scaffolded Next.js app (Этап 10).
- No automated tests yet (Этап 11).
