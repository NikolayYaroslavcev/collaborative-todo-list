import { ListRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipService } from '../common/membership.service';
import { PresenceService } from '../common/presence.service';
import { ListsService } from '../lists/lists.service';
import { TasksService } from '../tasks/tasks.service';
import { RealtimeGateway } from './realtime.gateway';
import { cleanupFixtures, createListWithMembers, createUser } from '../test-utils/fixtures';

/** Minimal fake matching just what these handlers touch on a Socket.IO
 *  client: `data` (auth + room bookkeeping) and `emit` (direct replies). */
function fakeClient(userId: string, name: string, joinedLists: string[] = []) {
  return {
    data: {
      user: { id: userId, name, email: `${userId}@test.local` },
      joinedLists: new Set(joinedLists),
    },
    emit: jest.fn(),
  } as unknown as Parameters<RealtimeGateway['handleEditingStart']>[0] & { emit: jest.Mock };
}

describe('RealtimeGateway', () => {
  describe('presence editing start/stop (in-memory, no DB)', () => {
    let gateway: RealtimeGateway;
    let presence: PresenceService;

    beforeEach(() => {
      presence = new PresenceService();
      gateway = new RealtimeGateway(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        presence,
      );
      gateway.server = { to: () => ({ emit: jest.fn() }) } as any;
    });

    it('records editingTaskId on start and clears it on a matching stop', () => {
      const client = fakeClient('user-a', 'Alice', ['list-1']);
      presence.addConnection('list-1', 'user-a', 'Alice', 'socket-1');

      gateway.handleEditingStart(client, { listId: 'list-1', taskId: 'task-1' });
      expect(presence.getPresence('list-1')[0].editingTaskId).toBe('task-1');

      gateway.handleEditingStop(client, { listId: 'list-1', taskId: 'task-1' });
      expect(presence.getPresence('list-1')[0].editingTaskId).toBeNull();
    });

    it('ignores a stale stop for a task the user is no longer editing (out-of-order delivery)', () => {
      const client = fakeClient('user-a', 'Alice', ['list-1']);
      presence.addConnection('list-1', 'user-a', 'Alice', 'socket-1');

      // User moved from task-1 to task-2...
      gateway.handleEditingStart(client, { listId: 'list-1', taskId: 'task-1' });
      gateway.handleEditingStart(client, { listId: 'list-1', taskId: 'task-2' });

      // ...but a stale "stop editing task-1" arrives after the fact (e.g. a
      // debounced/delayed network delivery). It must not clobber task-2.
      gateway.handleEditingStop(client, { listId: 'list-1', taskId: 'task-1' });

      expect(presence.getPresence('list-1')[0].editingTaskId).toBe('task-2');
    });

    it('ignores events for a list the client never joined', () => {
      const client = fakeClient('user-a', 'Alice', []); // joined nothing
      presence.addConnection('list-1', 'user-a', 'Alice', 'socket-1');

      gateway.handleEditingStart(client, { listId: 'list-1', taskId: 'task-1' });
      expect(presence.getPresence('list-1')[0].editingTaskId).toBeNull();
    });
  });

  describe('operationId round-trip on errors (real DB)', () => {
    let prisma: PrismaService;
    let gateway: RealtimeGateway;
    let presence: PresenceService;
    let tasksService: TasksService;
    const userIds: string[] = [];
    const listIds: string[] = [];

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      const membership = new MembershipService(prisma);
      presence = new PresenceService();
      const listsService = new ListsService(prisma, membership);
      tasksService = new TasksService(prisma, membership, presence);
      gateway = new RealtimeGateway(
        {} as any,
        {} as any,
        membership,
        listsService,
        tasksService,
        presence,
      );
      gateway.server = { to: () => ({ emit: jest.fn() }) } as any;
    });

    afterAll(async () => {
      await cleanupFixtures(prisma, { listIds, userIds });
      await prisma.$disconnect();
    });

    it('echoes the operationId back on a version conflict, so a replaying client can match it to its pending operation', async () => {
      const admin = await createUser(prisma, 'admin');
      userIds.push(admin.id);
      const list = await createListWithMembers(prisma, admin.id);
      listIds.push(list.id);
      const { task } = await tasksService.createTask(list.id, admin.id, 'Racey task');
      // Make the task's real version diverge from what the client will claim.
      await tasksService.updateTask(task.id, admin.id, { title: 'v2', baseVersion: task.version });

      const client = fakeClient(admin.id, admin.name, [list.id]);
      await gateway.handleUpdate(client, {
        taskId: task.id,
        title: 'stale edit',
        baseVersion: task.version, // now stale
        operationId: 'op-conflict-1',
      });

      expect(client.emit).toHaveBeenCalledWith(
        'task:conflict',
        expect.objectContaining({ operationId: 'op-conflict-1', code: 'VERSION_CONFLICT' }),
      );
    });

    it('echoes the operationId back on conflict:warning (delete blocked by an active editor)', async () => {
      const admin = await createUser(prisma, 'admin');
      const editor = await createUser(prisma, 'editor');
      userIds.push(admin.id, editor.id);
      const list = await createListWithMembers(prisma, admin.id, [
        { userId: editor.id, role: ListRole.MEMBER },
      ]);
      listIds.push(list.id);
      const { task } = await tasksService.createTask(list.id, admin.id, 'Being edited');

      presence.addConnection(list.id, editor.id, editor.name, 'socket-x');
      presence.setEditing(list.id, editor.id, task.id);

      const client = fakeClient(admin.id, admin.name, [list.id]);
      await gateway.handleDelete(client, { taskId: task.id, operationId: 'op-warn-1' });

      expect(client.emit).toHaveBeenCalledWith(
        'conflict:warning',
        expect.objectContaining({ operationId: 'op-warn-1', code: 'CONFIRMATION_REQUIRED' }),
      );
    });
  });
});
