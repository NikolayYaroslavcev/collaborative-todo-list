import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupFixtures } from '../src/test-utils/fixtures';

/**
 * Full-stack realtime tests: a real Nest HTTP+WebSocket server, two real
 * socket.io-client connections (one per simulated browser tab/user), and a
 * real Postgres database. This is what actually exercises the wire
 * protocol the frontend depends on — operationId echoing, list:sync on
 * (re)join, and the specific event names/shapes for conflicts and errors.
 */
describe('Realtime gateway (e2e, two independent clients)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  const userIds: string[] = [];
  const listIds: string[] = [];

  const PASSWORD = 'password123';

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof address === 'string' ? '' : address.port}`;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await cleanupFixtures(prisma, { listIds, userIds });
    await app.close();
  });

  async function makeLoggedInUser(namePrefix: string) {
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const user = await prisma.user.create({
      data: {
        email: `${namePrefix}-${Date.now()}-${Math.random()}@test.local`,
        name: namePrefix,
        passwordHash,
      },
    });
    userIds.push(user.id);

    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: PASSWORD }),
    });
    const body = (await res.json()) as { accessToken: string };
    return { user, token: body.accessToken };
  }

  async function makeList(ownerId: string, memberIds: string[] = []) {
    const list = await prisma.list.create({ data: { title: `RT list ${Date.now()}`, ownerId } });
    listIds.push(list.id);
    await prisma.listMember.create({ data: { listId: list.id, userId: ownerId, role: 'ADMIN' } });
    for (const id of memberIds) {
      await prisma.listMember.create({ data: { listId: list.id, userId: id, role: 'MEMBER' } });
    }
    return list;
  }

  function connect(token: string): Socket {
    return io(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
  }

  function waitFor<T = any>(
    socket: Socket,
    event: string,
    predicate?: (payload: T) => boolean,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), 8000);
      const handler = (payload: T) => {
        if (predicate && !predicate(payload)) return;
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      };
      socket.on(event, handler);
    });
  }

  async function join(socket: Socket, listId: string) {
    const syncPromise = waitFor(socket, 'list:sync');
    socket.emit('list:join', { listId });
    return syncPromise;
  }

  it("two independent clients see each other's realtime create/update/delete, and presence updates", async () => {
    const admin = await makeLoggedInUser('admin');
    const member = await makeLoggedInUser('member');
    const list = await makeList(admin.user.id, [member.user.id]);

    const clientA = connect(admin.token);
    const clientB = connect(member.token);
    await Promise.all([waitFor(clientA, 'connect'), waitFor(clientB, 'connect')]);

    await join(clientA, list.id);
    const bPresenceSeenByA = waitFor(clientA, 'presence:update', (p: any) =>
      p.presence.some((entry: any) => entry.userId === member.user.id),
    );
    await join(clientB, list.id);
    await bPresenceSeenByA;

    const created = waitFor(clientB, 'task:created');
    clientA.emit('task:create', {
      listId: list.id,
      title: 'Shared task',
      operationId: 'e2e-create-1',
    });
    const createdPayload = await created;
    expect(createdPayload.task.title).toBe('Shared task');
    expect(createdPayload.operationId).toBe('e2e-create-1');

    const updated = waitFor(clientA, 'task:updated');
    clientB.emit('task:update', {
      taskId: createdPayload.task.id,
      completed: true,
      baseVersion: createdPayload.task.version,
    });
    expect((await updated).task.completed).toBe(true);

    const deleted = waitFor(clientB, 'task:deleted');
    clientA.emit('task:delete', { taskId: createdPayload.task.id, force: true });
    expect((await deleted).taskId).toBe(createdPayload.task.id);

    clientA.disconnect();
    clientB.disconnect();
  });

  it('reconnect + reconciliation: a client that was offline sees changes made in the meantime via list:sync', async () => {
    const admin = await makeLoggedInUser('admin');
    const list = await makeList(admin.user.id);

    const clientA = connect(admin.token);
    await waitFor(clientA, 'connect');
    await join(clientA, list.id);

    // Simulate "offline": disconnect the socket entirely.
    clientA.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Something happens on the server while this client was offline (e.g. a
    // REST call, or another client's action).
    await fetch(`${baseUrl}/lists/${list.id}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ title: 'Created while offline' }),
    });

    // Reconnect: connect -> list:join -> list:sync is the reconcile step.
    const clientA2 = connect(admin.token);
    await waitFor(clientA2, 'connect');
    const sync = await join(clientA2, list.id);

    expect(sync.tasks.some((t: any) => t.title === 'Created while offline')).toBe(true);
    clientA2.disconnect();
  });

  it('replaying the same task:create operationId (idempotent retry) never creates a duplicate task', async () => {
    const admin = await makeLoggedInUser('admin');
    const list = await makeList(admin.user.id);
    const clientA = connect(admin.token);
    await waitFor(clientA, 'connect');
    await join(clientA, list.id);

    const first = waitFor(clientA, 'task:created', (p: any) => p.operationId === 'e2e-replay-1');
    clientA.emit('task:create', {
      listId: list.id,
      title: 'Replay me',
      operationId: 'e2e-replay-1',
    });
    const firstResult = await first;

    // Same operationId again — simulates a client that resent because it
    // never saw the first ack (e.g. a dropped connection right after).
    const second = waitFor(clientA, 'task:created', (p: any) => p.operationId === 'e2e-replay-1');
    clientA.emit('task:create', {
      listId: list.id,
      title: 'Replay me',
      operationId: 'e2e-replay-1',
    });
    const secondResult = await second;

    expect(secondResult.task.id).toBe(firstResult.task.id);
    const count = await prisma.task.count({ where: { listId: list.id, title: 'Replay me' } });
    expect(count).toBe(1);
    clientA.disconnect();
  });

  it('an invalid pending operation (stale baseVersion) errors cleanly with the operationId, instead of retrying forever', async () => {
    const admin = await makeLoggedInUser('admin');
    const list = await makeList(admin.user.id);
    const clientA = connect(admin.token);
    await waitFor(clientA, 'connect');
    const sync = await join(clientA, list.id);
    void sync;

    const created = waitFor(clientA, 'task:created');
    clientA.emit('task:create', { listId: list.id, title: 'Will conflict' });
    const task = (await created).task;

    // Bump the version server-side out from under our stale baseVersion.
    const bumped = waitFor(clientA, 'task:updated');
    clientA.emit('task:update', { taskId: task.id, title: 'v2', baseVersion: task.version });
    await bumped;

    const conflict = waitFor(clientA, 'task:conflict');
    clientA.emit('task:update', {
      taskId: task.id,
      title: 'stale',
      baseVersion: task.version, // stale now
      operationId: 'e2e-stale-1',
    });
    const conflictPayload = await conflict;
    expect(conflictPayload.operationId).toBe('e2e-stale-1');
    expect(conflictPayload.code).toBe('VERSION_CONFLICT');
    clientA.disconnect();
  });

  it('a deleted task never resurrects from a stale queued update, and stays gone', async () => {
    const admin = await makeLoggedInUser('admin');
    const list = await makeList(admin.user.id);
    const clientA = connect(admin.token);
    await waitFor(clientA, 'connect');
    await join(clientA, list.id);

    const created = waitFor(clientA, 'task:created');
    clientA.emit('task:create', { listId: list.id, title: 'Will be deleted' });
    const task = (await created).task;

    const deleted = waitFor(clientA, 'task:deleted');
    clientA.emit('task:delete', { taskId: task.id, force: true });
    await deleted;

    // A stale queued edit for the now-deleted task (as if it were replayed
    // from an offline queue) must fail, not resurrect the task.
    const error = waitFor(clientA, 'error');
    clientA.emit('task:update', {
      taskId: task.id,
      title: 'too late',
      baseVersion: task.version,
      operationId: 'e2e-stale-delete',
    });
    const errorPayload = await error;
    expect(errorPayload.status).toBe(404);
    expect(errorPayload.operationId).toBe('e2e-stale-delete');

    const stillGone = await prisma.task.findUnique({ where: { id: task.id } });
    expect(stillGone).toBeNull();
    clientA.disconnect();
  });
});
