import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ListRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipService } from '../common/membership.service';
import { PresenceService } from '../common/presence.service';
import { TasksService } from './tasks.service';
import { cleanupFixtures, createListWithMembers, createUser } from '../test-utils/fixtures';

/**
 * Integration tests against a real Postgres database (backend/.env.test) —
 * deliberately NOT mocking Prisma. The behavior under test (advisory-lock
 * serialization, atomic version-conditioned UPDATE/DELETE, unique-key
 * idempotency records) only exists at the database layer, so a mocked
 * PrismaClient would test nothing about the actual concurrency guarantees.
 */
describe('TasksService (concurrency, permissions, idempotency, reorder)', () => {
  let prisma: PrismaService;
  let tasksService: TasksService;
  let presence: PresenceService;

  const userIds: string[] = [];
  const listIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    const membership = new MembershipService(prisma);
    presence = new PresenceService();
    tasksService = new TasksService(prisma, membership, presence);
  });

  afterAll(async () => {
    await cleanupFixtures(prisma, { listIds, userIds });
    await prisma.$disconnect();
  });

  async function makeUser(name: string) {
    const user = await createUser(prisma, name);
    userIds.push(user.id);
    return user;
  }

  async function makeList(ownerId: string, members: { userId: string; role: ListRole }[] = []) {
    const list = await createListWithMembers(prisma, ownerId, members);
    listIds.push(list.id);
    return list;
  }

  describe('concurrent update', () => {
    it('lets exactly one of two simultaneous edits win; the loser gets VERSION_CONFLICT with the winning task', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const { task } = await tasksService.createTask(list.id, admin.id, 'Original title');

      const results = await Promise.allSettled([
        tasksService.updateTask(task.id, admin.id, { title: 'From A', baseVersion: task.version }),
        tasksService.updateTask(task.id, admin.id, { title: 'From B', baseVersion: task.version }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

      const winnerTitle = (fulfilled[0] as PromiseFulfilledResult<{ task: { title: string } }>)
        .value.task.title;
      const final = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(final.title).toBe(winnerTitle);
      expect(final.version).toBe(task.version + 1);
    });

    it('rejects a stale baseVersion even with no concurrent request in flight', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const { task } = await tasksService.createTask(list.id, admin.id, 'v1');
      await tasksService.updateTask(task.id, admin.id, { title: 'v2', baseVersion: task.version });

      await expect(
        tasksService.updateTask(task.id, admin.id, { title: 'v3', baseVersion: task.version }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'VERSION_CONFLICT' }),
      });
    });
  });

  describe('concurrent delete', () => {
    it('lets exactly one of two simultaneous deletes win; the other sees NotFound (already gone)', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const { task } = await tasksService.createTask(list.id, admin.id, 'To delete');

      const results = await Promise.allSettled([
        tasksService.deleteTask(task.id, admin.id, true),
        tasksService.deleteTask(task.id, admin.id, true),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

      const remaining = await prisma.task.findUnique({ where: { id: task.id } });
      expect(remaining).toBeNull();
    });
  });

  describe('permissions', () => {
    it('a member cannot delete a task created by someone else', async () => {
      const admin = await makeUser('admin');
      const member = await makeUser('member');
      const list = await makeList(admin.id, [{ userId: member.id, role: ListRole.MEMBER }]);
      const { task } = await tasksService.createTask(list.id, admin.id, 'Admin task');

      await expect(tasksService.deleteTask(task.id, member.id, false)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('a member can delete a task they created themselves', async () => {
      const admin = await makeUser('admin');
      const member = await makeUser('member');
      const list = await makeList(admin.id, [{ userId: member.id, role: ListRole.MEMBER }]);
      const { task } = await tasksService.createTask(list.id, member.id, 'Member task');

      await expect(tasksService.deleteTask(task.id, member.id, false)).resolves.toMatchObject({
        taskId: task.id,
      });
    });

    it('a member can never delete a completed task, even their own, even with force', async () => {
      const admin = await makeUser('admin');
      const member = await makeUser('member');
      const list = await makeList(admin.id, [{ userId: member.id, role: ListRole.MEMBER }]);
      const { task } = await tasksService.createTask(list.id, member.id, 'Member task');
      await tasksService.updateTask(task.id, member.id, {
        completed: true,
        baseVersion: task.version,
      });

      await expect(tasksService.deleteTask(task.id, member.id, true)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('an admin deleting a completed task without force gets a confirmation-required error, and with force it succeeds', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const { task } = await tasksService.createTask(list.id, admin.id, 'Done task');
      await tasksService.updateTask(task.id, admin.id, {
        completed: true,
        baseVersion: task.version,
      });

      await expect(tasksService.deleteTask(task.id, admin.id, false)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONFIRMATION_REQUIRED',
          reasons: ['COMPLETED'],
        }),
      });

      await expect(tasksService.deleteTask(task.id, admin.id, true)).resolves.toMatchObject({
        taskId: task.id,
      });
    });

    it('a non-member cannot mutate tasks in the list', async () => {
      const admin = await makeUser('admin');
      const outsider = await makeUser('outsider');
      const list = await makeList(admin.id);
      const { task } = await tasksService.createTask(list.id, admin.id, 'Private task');

      await expect(tasksService.createTask(list.id, outsider.id, 'Sneaky')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        tasksService.updateTask(task.id, outsider.id, { title: 'hacked' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('delete vs active editing', () => {
    it('blocks a non-force delete while another member is editing the task, and reports who', async () => {
      const admin = await makeUser('admin');
      const editor = await makeUser('editor');
      const list = await makeList(admin.id, [{ userId: editor.id, role: ListRole.MEMBER }]);
      const { task } = await tasksService.createTask(list.id, admin.id, 'Being edited');

      presence.addConnection(list.id, editor.id, editor.name, 'socket-1');
      presence.setEditing(list.id, editor.id, task.id);

      await expect(tasksService.deleteTask(task.id, admin.id, false)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONFIRMATION_REQUIRED',
          reasons: expect.arrayContaining(['BEING_EDITED']),
          editedBy: [{ userId: editor.id, name: editor.name }],
        }),
      });

      // Forcing through after the warning is the documented recovery path.
      await expect(tasksService.deleteTask(task.id, admin.id, true)).resolves.toMatchObject({
        taskId: task.id,
      });
    });
  });

  describe('operation idempotency (offline-queue replay)', () => {
    it('create: replaying the same operationId never creates a second task', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const operationId = `op-create-${admin.id}`;

      const first = await tasksService.createTask(
        list.id,
        admin.id,
        'Idempotent create',
        operationId,
      );
      const second = await tasksService.createTask(
        list.id,
        admin.id,
        'Idempotent create',
        operationId,
      );

      expect(second.task.id).toBe(first.task.id);
      const count = await prisma.task.count({
        where: { listId: list.id, title: 'Idempotent create' },
      });
      expect(count).toBe(1);
    });

    it('update: replaying the same operationId does not double-apply the edit', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const { task } = await tasksService.createTask(list.id, admin.id, 'v1');
      const operationId = `op-update-${admin.id}`;

      const first = await tasksService.updateTask(task.id, admin.id, {
        title: 'v2',
        baseVersion: task.version,
        operationId,
      });
      const second = await tasksService.updateTask(task.id, admin.id, {
        title: 'v2',
        baseVersion: task.version,
        operationId,
      });

      expect(second.task.version).toBe(first.task.version);
      const final = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(final.version).toBe(task.version + 1);
    });

    it('delete: replaying the same operationId after the task is gone returns the cached result instead of erroring or resurrecting it', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const { task } = await tasksService.createTask(list.id, admin.id, 'To delete twice');
      const operationId = `op-delete-${admin.id}`;

      const first = await tasksService.deleteTask(task.id, admin.id, false, operationId);
      const second = await tasksService.deleteTask(task.id, admin.id, false, operationId);

      expect(second).toEqual(first);
      const remaining = await prisma.task.findUnique({ where: { id: task.id } });
      expect(remaining).toBeNull();
    });

    it('a replayed operation with no matching cache against a since-deleted task fails cleanly instead of resurrecting it', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const { task } = await tasksService.createTask(list.id, admin.id, 'Deleted while offline');
      await tasksService.deleteTask(task.id, admin.id, true);

      // Simulates a client replaying a queued edit it made before the
      // connection dropped, without ever having sent it (so there's no
      // idempotency record) — the delete happened server-side in the
      // meantime via a different client.
      await expect(
        tasksService.updateTask(task.id, admin.id, {
          title: 'too late',
          baseVersion: task.version,
          operationId: `op-stale-${admin.id}`,
        }),
      ).rejects.toMatchObject({ status: 404 });

      const stillGone = await prisma.task.findUnique({ where: { id: task.id } });
      expect(stillGone).toBeNull();
    });
  });

  describe('reorder', () => {
    it('places a task between its given neighbors', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const a = (await tasksService.createTask(list.id, admin.id, 'A')).task;
      const b = (await tasksService.createTask(list.id, admin.id, 'B')).task;
      const c = (await tasksService.createTask(list.id, admin.id, 'C')).task;

      await tasksService.reorderTask(c.id, admin.id, {
        beforeId: a.id,
        afterId: b.id,
        baseVersion: c.version,
      });

      const ordered = await prisma.task.findMany({
        where: { listId: list.id },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      expect(ordered.map((t) => t.id)).toEqual([a.id, c.id, b.id]);
    });

    it('rejects a stale baseVersion on reorder', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const a = (await tasksService.createTask(list.id, admin.id, 'A')).task;
      const b = (await tasksService.createTask(list.id, admin.id, 'B')).task;

      // Bump the task's version out from under a client that captured an
      // older baseVersion before this update happened.
      await tasksService.updateTask(a.id, admin.id, { title: 'A renamed', baseVersion: a.version });

      await expect(
        tasksService.reorderTask(a.id, admin.id, { afterId: b.id, baseVersion: a.version }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('replaying the same reorder operationId does not shift the task twice', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const a = (await tasksService.createTask(list.id, admin.id, 'A')).task;
      const b = (await tasksService.createTask(list.id, admin.id, 'B')).task;
      const operationId = `op-reorder-${admin.id}`;

      const first = await tasksService.reorderTask(a.id, admin.id, {
        afterId: b.id,
        baseVersion: a.version,
        operationId,
      });
      const second = await tasksService.reorderTask(a.id, admin.id, {
        afterId: b.id,
        baseVersion: a.version,
        operationId,
      });

      // The cached replay round-trips through JSON (Postgres `Json` column),
      // so Date fields come back as ISO strings rather than Date instances —
      // harmless (every real consumer is WS/REST, which JSON-serializes
      // either way) but not `toEqual`-identical to the freshly-returned
      // first result. Compare through the same normalization.
      expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
      const final = await prisma.task.findUniqueOrThrow({ where: { id: a.id } });
      expect(final.version).toBe(a.version + 1);
    });

    it('resolves two concurrent reorders onto the same anchor without corrupting order (no duplicates, no dropped tasks)', async () => {
      const admin = await makeUser('admin');
      const list = await makeList(admin.id);
      const a = (await tasksService.createTask(list.id, admin.id, 'A')).task;
      const b = (await tasksService.createTask(list.id, admin.id, 'B')).task;
      const c = (await tasksService.createTask(list.id, admin.id, 'C')).task;

      // B and C both race to become "the task right after A" (no baseVersion
      // check, so both are accepted — the advisory lock just serializes
      // them). Anchored to the same single-sided neighbor with nothing on
      // the other side, they can legitimately compute the identical
      // fractional key (documented in reorderTask) — that's fine as long as
      // no row is lost/duplicated and the deterministic (position, id)
      // tie-break still produces one consistent order both clients would
      // converge on.
      await Promise.all([
        tasksService.reorderTask(b.id, admin.id, { beforeId: a.id }),
        tasksService.reorderTask(c.id, admin.id, { beforeId: a.id }),
      ]);

      const ordered = await prisma.task.findMany({
        where: { listId: list.id },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      expect(ordered.map((t) => t.id).sort()).toEqual([a.id, b.id, c.id].sort());
      expect(ordered[0].id).toBe(a.id);

      const reFetched = await prisma.task.findMany({
        where: { listId: list.id },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      expect(reFetched.map((t) => t.id)).toEqual(ordered.map((t) => t.id));
    });
  });
});
