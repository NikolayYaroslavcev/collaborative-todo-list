# Collaborative Todo List

A realtime, multi-user todo list. Multiple people work on the same list at once: task changes,
presence, drag-and-drop reordering and delete/edit conflicts all sync live over WebSockets, with
the server as the single source of truth and an offline queue on the client for connectivity gaps.

## Highlights

- **Server is the single source of truth.** Every mutation, on REST or WebSocket, runs
  `validate → business rules → DB transaction → broadcast`; nothing is broadcast on an in-memory
  guess before the write actually lands in Postgres. See [Architecture](#architecture).
- **Concurrent edits are resolved by server-ordered optimistic concurrency**, not client
  timestamps: a single conditional `UPDATE ... WHERE version = ?` decides the winner atomically,
  and every other write against that same stale version gets back a `VERSION_CONFLICT`. See
  [Concurrent edit](#concurrent-edit).
- **Concurrent reordering is race-safe**: task positions are fractional-index strings (no
  renumbering on insert), and a Postgres advisory lock serializes reorders on the same list across
  any number of backend instances. See [Concurrent reorder](#concurrent-reorder).
- **Offline queue and idempotency**: every mutation carries a client-generated `operationId`;
  replays, whether from the offline queue or a dropped-ack retry, are deduped against a durable
  Postgres record, not process memory. See [Idempotency](#idempotency).
- **Permissions are enforced server-side** on every REST and WebSocket entry point (list
  membership, admin vs member, completed-task rules), never just hidden in the UI. See
  [Permissions](#permissions).

## Features

- Email/password auth with JWT, shared between the REST API and the WebSocket handshake.
- Lists with an owner/admin and invited members; invite links with an optional role and expiry.
- Realtime task CRUD and drag-and-drop reordering, synced to every connected member of a list.
- Presence: who's online, and who is currently editing which task.
- Conflict handling for concurrent edits, concurrent reorders, and delete-vs-edit races.
- An offline queue on the client that replays queued mutations, in order, on reconnect.

## Tech stack

- **Backend:** NestJS, Prisma, PostgreSQL, Socket.IO, JWT (Passport)
- **Frontend:** Next.js (App Router), React, TypeScript, Socket.IO client, dnd-kit

## Project structure

```
/backend             NestJS API + WebSocket gateway
/frontend             Next.js app
/docker-compose.yml   PostgreSQL for local dev
```

## Architecture

The backend is a single NestJS app exposing both a REST API and a Socket.IO gateway on the same
port. They share the same services, Prisma client, and JWT verification, so there is exactly one
implementation of every business rule regardless of which transport a client used to trigger it.

- `auth/`: login, JWT issuing/verification (`JwtAuthGuard` for REST, a Socket.IO `server.use`
  middleware for WebSocket handshakes).
- `lists/`: list CRUD, invites.
- `tasks/`: task CRUD, reordering, conflict/idempotency logic. `TasksService` is where most of
  the concurrency handling described below lives.
- `common/`: cross-cutting services, namely list membership checks (`MembershipService`) and
  in-memory presence (`PresenceService`).
- `realtime/`: the Socket.IO gateway. It wires WS events to the same `TasksService`/`ListsService`
  used by REST, and broadcasts the results.
- `prisma/`: schema and migrations. PostgreSQL is the single source of truth for everything
  except presence (see [Presence](#presence)).

Frontend: a Next.js App Router app (`/login`, `/lists`, `/lists/[id]`, `/invites/[token]`) backed
by a single WebSocket connection per open list (`use-list-realtime.ts`), a REST client for auth
and list management (`lib/api.ts`), and a persisted offline queue (`lib/offline-queue.ts`).

## Data model

`User`, `List`, `ListMember` (role `ADMIN`/`MEMBER`), `Task`, `Invite`,
`OperationIdempotencyRecord`. See `backend/prisma/schema.prisma`.

`Task.position` is a fractional-index string (via the `fractional-indexing` package) rather than
an integer, so inserting a task between two neighbors never requires reindexing every other row.
That matters once two clients can reorder the same list at the same time (see
[Concurrent reorder](#concurrent-reorder)).

## Running locally

1. Start PostgreSQL:
   ```
   docker compose up -d postgres
   ```
2. Backend:
   ```
   cd backend
   cp .env.example .env
   npm install
   npm run prisma:migrate   # applies migrations
   npm run prisma:seed      # creates demo users + demo list
   npm run start:dev
   ```
   API and WebSocket gateway listen on `http://localhost:3001`.
3. Frontend:
   ```
   cd frontend
   npm install
   cp .env.local.example .env.local
   npm run dev
   ```
   App listens on `http://localhost:3000`. Sign in with either seeded account below; the flow
   goes login → lists → a list's tasks, with realtime updates, presence, drag-and-drop reorder,
   offline queueing and conflict handling all live.

## Test users

Seeded by `backend/prisma/seed.ts`:

| Email | Password | Role on "Demo List" |
| --- | --- | --- |
| admin@example.com | password123 | ADMIN (owner) |
| member@example.com | password123 | MEMBER |

## API

- `POST /auth/login`: returns `{ accessToken, user }`
- `GET /auth/me`: protected, returns the current user
- `GET /lists` / `POST /lists` / `GET /lists/:id` / `DELETE /lists/:id`
- `POST /lists/:id/invite` (admin only): creates an invite token/link (no email is sent)
- `POST /invites/:token/accept`
- `GET /lists/:listId/tasks` / `POST /lists/:listId/tasks`
- `PATCH /tasks/:id`: body may include `baseVersion` for optimistic-concurrency checks
- `DELETE /tasks/:id?force=true`: `force` is required to delete a completed task, and only an
  admin may do so

All endpoints except `/auth/login` require `Authorization: Bearer <jwt>` and enforce list
membership server-side.

## WebSocket protocol

Clients connect to the default Socket.IO namespace with the JWT in the handshake
(`io(url, { auth: { token } })`). Authentication runs as server-side middleware, so a missing or
invalid token rejects the handshake itself rather than connecting and then disconnecting.

Client → server: `list:join`, `list:leave`, `task:create`, `task:update`, `task:delete`,
`task:reorder`, `presence:editing:start` / `presence:editing:stop`. Every mutation accepts an
optional `operationId` (see [Idempotency](#idempotency)); `task:update` and `task:reorder` also
accept `baseVersion` for the conflict check described below.

Server → client: `list:sync` (full state, sent on join and re-requested on every reconnect),
`presence:update`, `task:created` / `task:updated` / `task:deleted` / `task:reordered`
(broadcast to the room), and `task:conflict` / `conflict:warning` / `error` (sent only to the
requester, for version conflicts, delete confirmations, and other failures respectively).

`List.version` and `Task.version` are incremented on every change and are what the conflict
handling below is built on.

## Presence

Presence is intentionally not stored in PostgreSQL. It lives only in the gateway's process
memory, keyed `listId → userId → { online, editingTaskId }`. It's inherently ephemeral
per-connection state, not a durable fact worth a row and a migration, and it needs to disappear
the instant a socket drops. A `presence:update` broadcast follows any change, whether that's a
connect/disconnect or an editing-start/stop.

The client debounces outgoing `presence:editing:start/stop` events so that typing doesn't spam
the socket. The server tracks each client's last-sent editing target so a stale, delayed "stop
editing A" arriving after a newer "start editing B" can't clobber the current state.

## Conflict handling

The client's wall clock is never trusted as an ordering signal, because clock skew between two
browsers makes "the newer timestamp wins" unsafe. Every conflict check instead runs against
server-ordered state, using `Task.version` (and, for reordering, `Task.position`) as the single
ordering authority.

### Concurrent edit

The client sends the `Task.version` it last saw as `baseVersion`. The update is applied as a
single conditional `UPDATE ... WHERE id = ? AND version = ?`: whichever request's `WHERE` matches
first commits and bumps the version, and every later request against that same stale version no
longer matches. The server then re-reads the row and returns `VERSION_CONFLICT` with the current
task. This is a server-ordered last-write-wins: the database decides the order, not either
client, and the conflict is detected atomically inside the write itself rather than by a separate
check-then-write step that a second request could race through.

### Delete vs. edit

If user A is editing a task (tracked via presence) and user B tries to delete it without
confirmation, the server responds with `conflict:warning` (`CONFIRMATION_REQUIRED`) instead of
deleting. The same applies to deleting a completed task. Resending the delete with `force: true`
re-validates from scratch: existence, permissions, completed status, current version, rather
than trusting the earlier check, since state may have changed again in between.

A completed task can only ever be deleted by an admin, with `force: true` required. A member
cannot bypass this rule regardless of confirmation.

### Concurrent reorder

Positions are fractional-index strings (inserting between `A` and `M` produces something like
`G`), not integers, so a reorder never requires renumbering other rows. Reordering the same list
from two clients at once is additionally serialized by a Postgres transaction-scoped advisory
lock (`pg_advisory_xact_lock`, keyed by a hash of the list id). The lock lives in the database, so
it correctly orders position-affecting writes across any number of backend processes, not just
within one. Two inserts anchored at the same single-sided neighbor can legitimately compute an
identical fractional key. Task lists are always read back ordered by `(position, id)`, which
gives every client the same deterministic tie-break and the same final order.

## Idempotency

Every WebSocket mutation accepts an optional client-generated `operationId`. The result of the
first successful attempt is stored in `OperationIdempotencyRecord`, keyed by `(userId,
operationId)`. Replaying the same `operationId`, whether that's a client that never saw the ack
because of a dropped connection or the offline queue replaying after a reconnect, returns the
cached result instead of re-applying the mutation. The record lives in Postgres rather than
process memory, so a replay is deduped correctly no matter which backend instance ends up
handling it.

Idempotency is a WebSocket-level concern: the REST endpoints don't take an `operationId`, since
the offline queue always replays over the WebSocket connection once it's back up.

## Offline mode

The frontend queues every mutation (create/update/delete/reorder) through the same code path
whether the socket is connected or not. An "online" action just drains its queue immediately.
Each queued operation carries the `operationId` idempotency key described above.

Flow: `connect → list:join → list:sync (reconcile) → replay pending operations, one at a time`.
The queue is persisted to `localStorage` per list, so it survives a page reload while offline, not
just a WebSocket reconnect. Replay is a single attempt per operation; nothing is retried forever:

- a stale `baseVersion` on replay surfaces the same conflict UI as a live edit conflict;
- a replayed operation targeting a task deleted in the meantime fails with 404, which the client
  treats as "drop the change, don't resurrect the task" (for a queued delete of an
  already-deleted task, 404 is instead treated as success, since the goal was already achieved);
- a delete blocked by `CONFIRMATION_REQUIRED` (completed task, or being edited; offline clients
  can't know live presence) is dropped from auto-replay and surfaced for the user to retry
  manually, rather than auto-forcing it through.

## Permissions

- Only a member of a list can read or write its tasks. This is enforced server-side on every REST
  and WebSocket entry point, not just hidden in the UI.
- An admin (the list's owner, or a member invited with the `ADMIN` role) can delete any task.
- A member can delete only tasks they created themselves.
- A completed task can't be deleted the normal way; only an admin can, and only with `force: true`.

## Testing

- **Unit/integration** (`backend/src/**/*.spec.ts`): `TasksService` against a real Postgres,
  covering concurrent update/delete, stale `baseVersion`, permissions (member vs admin,
  completed-task rules), delete-vs-active-editing, operation idempotency (create/update/delete/
  reorder replay), and reorder including concurrent reorders onto the same anchor. Plus
  `PresenceService` (pure) and `RealtimeGateway` (stale presence-stop guard, `operationId`
  echoing).
- **E2E** (`backend/test/**/*.e2e-spec.ts`): a real Nest HTTP+WebSocket server with two independent
  `socket.io-client` connections, covering realtime create/update/delete/presence between two
  clients, reconnect and reconciliation, replay idempotency, invalid/stale replayed operations,
  and no resurrection of deleted tasks. Plus REST auth/list/invite/task flows and permission
  checks.
- **Frontend** (`frontend/src/**/*.test.{ts,tsx}`, Vitest): the offline queue's coalescing rules,
  task-list sort/merge helpers, and a connection-status component test.

Backend tests need a dedicated test database, kept separate from the dev database so tests never
touch seeded demo data:

```
docker exec collaborative-todo-postgres psql -U todo -d collaborative_todo -c "CREATE DATABASE collaborative_todo_test"
cd backend
cp .env.example .env.test   # then change DATABASE_URL's db name to collaborative_todo_test
DATABASE_URL="postgresql://todo:todo@localhost:5432/collaborative_todo_test?schema=public" npx prisma migrate deploy
npm test            # unit/integration specs (src/**/*.spec.ts)
npm run test:e2e    # e2e specs (test/**/*.e2e-spec.ts)
```

Frontend:

```
cd frontend
npm test
```

## Verification

Backend: `npm run lint:check`, `npm test`, `npm run test:e2e` in `backend/`. Frontend:
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build` in `frontend/`.

To verify against a clean test database without touching dev data, drop and recreate only the
test database rather than the Postgres container's volume:

```
docker exec collaborative-todo-postgres psql -U todo -d collaborative_todo -c "DROP DATABASE IF EXISTS collaborative_todo_test"
docker exec collaborative-todo-postgres psql -U todo -d collaborative_todo -c "CREATE DATABASE collaborative_todo_test"
cd backend
DATABASE_URL="postgresql://todo:todo@localhost:5432/collaborative_todo_test?schema=public" npx prisma migrate deploy
npm test && npm run test:e2e
```

Beyond the automated suite, exercise the realtime paths manually with two browser sessions signed
in as the two seeded users: create, update, delete and reorder a task in one and watch it appear
in the other; edit the same task from both at once to see the conflict banner; drag-reorder from
both at once; go offline in one tab (dev tools → offline), make changes, and reconnect to see the
queue replay.

## Known limitations

If a task is created while offline, the create succeeds server-side, and then the client edits
that same task again before the connection round-trip completes and it learns the create already
landed, that second edit can be lost. The cached idempotent replay returns the original create's
result, not a merged one. This requires a specific partial-connectivity timing window and doesn't
occur in the common fully-offline-then-reconnect case.

Invite creation issues a shareable link rather than sending an email; there is no mail-sending
integration in this project.

## Future improvements

- Send invite links by email instead of requiring them to be copied and shared manually.
- Move presence from a single gateway process's memory to a shared store (e.g. Redis) if the
  backend needs to run as more than one instance. REST and DB-backed writes already scale across
  instances via the Postgres advisory lock and idempotency table, but in-memory presence
  currently does not.
