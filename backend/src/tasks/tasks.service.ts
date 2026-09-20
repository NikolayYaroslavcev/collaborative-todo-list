import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ListRole, Prisma, Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipService } from '../common/membership.service';
import { PresenceService } from '../common/presence.service';
import { generateKeyBetween, generateNKeysBetween } from '../common/fractional-index';

export interface TaskMutationResult {
  task: Task;
  listVersion: number;
}

/** Positions past this length get rebalanced back down to short keys. Normal
 *  usage stays well under this; it only fires under pathological repeated
 *  inserts at the exact same spot (fractional-indexing keys grow with depth). */
const MAX_POSITION_LENGTH = 200;

/** Idempotency records older than this are opportunistically pruned. There's
 *  no scheduler in this stack, so cleanup piggybacks on writes instead of
 *  running as a background job. */
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
    private readonly presence: PresenceService,
  ) {}

  // ---------------------------------------------------------------------
  // Per-list ordering lock
  //
  // Position generation (create-at-end, reorder-between-neighbors) reads
  // neighbor rows and then writes a value derived from them. Doing that
  // read+compute+write non-atomically means two concurrent operations on
  // the same list can read the same neighbors and independently compute
  // the identical fractional key, or worse, compute a key against neighbor
  // positions that are stale by the time the write lands.
  //
  // This is a Postgres transaction-scoped advisory lock
  // (`pg_advisory_xact_lock`), not an in-process mutex: the lock lives in
  // Postgres itself, keyed by a hash of the listId, so it correctly
  // serializes position-affecting operations on the same list across ANY
  // number of backend instances/processes — not just within one. It's
  // acquired as the first statement of the transaction and released
  // automatically on commit or rollback (the `_xact_` variant, not the
  // session variant, so a dropped connection can never leak the lock).
  //
  // hashtextextended can theoretically collide for two different listIds
  // (birthday bound on a 64-bit hash) — astronomically unlikely at this
  // scale, and a collision would only ever cause two unrelated lists to be
  // serialized against each other, never a correctness violation.
  // ---------------------------------------------------------------------
  private async acquireListLock(tx: Prisma.TransactionClient, listId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${listId}::text, 0))`;
  }

  // ---------------------------------------------------------------------
  // Operation idempotency (operationId)
  //
  // A client may retry the same mutation — e.g. it never saw the ack
  // because of a dropped connection, or it's replaying its offline queue
  // after a reconnect and doesn't know whether the operation already
  // reached the server before it went offline. The result is recorded in
  // Postgres, keyed by (userId, operationId), so a replay is deduped
  // correctly no matter which backend instance handles it — process memory
  // would only dedupe within one instance, which isn't a safe assumption
  // once mutations can be served by any instance behind a load balancer.
  //
  // For `createTask` and `reorderTask`, the lookup-then-insert happens
  // inside the same list-locked transaction as the mutation it guards, so
  // the two are atomic together and a genuine concurrent replay is
  // serialized by the advisory lock. `updateTask` and `deleteTask` check
  // inside their own transaction but without a list-wide lock (they don't
  // need one for correctness of the mutation itself, which is guarded by
  // the atomic version-conditioned WHERE) — this leaves a narrow window
  // where two *literally concurrent* replays of the same operationId could
  // both race past the idempotency check and one gets a spurious conflict
  // instead of the cached result. That's only reachable if a single client
  // fires the same operationId twice in parallel, which a correctly
  // implemented offline-queue replay (one in-flight operation at a time)
  // never does.
  // ---------------------------------------------------------------------
  private async findCachedOperation<T>(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    operationId: string,
  ): Promise<T | undefined> {
    const record = await client.operationIdempotencyRecord.findUnique({
      where: { userId_operationId: { userId, operationId } },
    });
    // Stored as JSON, so Date fields round-trip as ISO strings rather than
    // Date instances. Harmless here: the only consumer is the WS/REST layer,
    // which serializes to JSON for transport either way.
    return record ? (record.result as unknown as T) : undefined;
  }

  private async storeOperationResult(
    tx: Prisma.TransactionClient,
    userId: string,
    operationId: string,
    result: unknown,
  ): Promise<void> {
    await tx.operationIdempotencyRecord.create({
      data: {
        userId,
        operationId,
        result: result as Prisma.InputJsonValue,
      },
    });

    // Opportunistic cleanup: cheap, bounded, and only runs on a small
    // fraction of writes so it doesn't add latency to every mutation.
    if (Math.random() < 0.02) {
      await tx.operationIdempotencyRecord.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - IDEMPOTENCY_RETENTION_MS) } },
      });
    }
  }

  async listTasks(listId: string, userId: string) {
    await this.membership.requireMembership(listId, userId);
    return this.prisma.task.findMany({
      where: { listId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  }

  private async loadTaskOrThrow(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return task;
  }

  private async bumpListVersion(tx: Prisma.TransactionClient, listId: string): Promise<number> {
    const list = await tx.list.update({
      where: { id: listId },
      data: { version: { increment: 1 } },
    });
    return list.version;
  }

  /** Reassigns short, evenly-spaced positions to every task in the list,
   *  preserving current order. Does not bump `version` — this is internal
   *  housekeeping, not a semantic edit, and must not trip anyone's
   *  optimistic-concurrency check on title/completed. */
  private async rebalanceListPositions(tx: Prisma.TransactionClient, listId: string) {
    const tasks = await tx.task.findMany({
      where: { listId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, position: true },
    });
    if (tasks.length === 0) return;

    const freshKeys = generateNKeysBetween(null, null, tasks.length);
    await Promise.all(
      tasks.map((t, i) =>
        freshKeys[i] === t.position
          ? Promise.resolve()
          : tx.task.update({ where: { id: t.id }, data: { position: freshKeys[i] } }),
      ),
    );
  }

  async createTask(
    listId: string,
    userId: string,
    title: string,
    operationId?: string,
  ): Promise<TaskMutationResult> {
    await this.membership.requireMembership(listId, userId);

    if (operationId) {
      const cached = await this.findCachedOperation<TaskMutationResult>(
        this.prisma,
        userId,
        operationId,
      );
      if (cached) return cached;
    }

    return this.prisma.$transaction(async (tx) => {
      await this.acquireListLock(tx, listId);

      if (operationId) {
        const cached = await this.findCachedOperation<TaskMutationResult>(tx, userId, operationId);
        if (cached) return cached;
      }

      const last = await tx.task.findFirst({
        where: { listId },
        orderBy: [{ position: 'desc' }, { id: 'desc' }],
      });
      let position = generateKeyBetween(last?.position ?? null, null);

      if (position.length > MAX_POSITION_LENGTH) {
        await this.rebalanceListPositions(tx, listId);
        const rebalancedLast = await tx.task.findFirst({
          where: { listId },
          orderBy: [{ position: 'desc' }, { id: 'desc' }],
        });
        position = generateKeyBetween(rebalancedLast?.position ?? null, null);
      }

      const task = await tx.task.create({
        data: {
          listId,
          title,
          position,
          createdById: userId,
          lastEditedById: userId,
        },
      });

      const listVersion = await this.bumpListVersion(tx, listId);
      const result: TaskMutationResult = { task, listVersion };

      if (operationId) {
        await this.storeOperationResult(tx, userId, operationId, result);
      }

      return result;
    });
  }

  async updateTask(
    taskId: string,
    userId: string,
    dto: { title?: string; completed?: boolean; baseVersion?: number; operationId?: string },
  ): Promise<TaskMutationResult> {
    const existing = await this.loadTaskOrThrow(taskId);
    await this.membership.requireMembership(existing.listId, userId);

    if (dto.operationId) {
      const cached = await this.findCachedOperation<TaskMutationResult>(
        this.prisma,
        userId,
        dto.operationId,
      );
      if (cached) return cached;
    }

    if (dto.baseVersion !== undefined && dto.baseVersion !== existing.version) {
      throw new ConflictException({
        message: 'Task was modified by someone else',
        code: 'VERSION_CONFLICT',
        currentTask: existing,
      });
    }

    if (dto.title === undefined && dto.completed === undefined) {
      const list = await this.prisma.list.findUniqueOrThrow({ where: { id: existing.listId } });
      return { task: existing, listVersion: list.version };
    }

    const data: Prisma.TaskUncheckedUpdateManyInput = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.completed !== undefined ? { completed: dto.completed } : {}),
      lastEditedById: userId,
      version: { increment: 1 },
    };

    return this.prisma.$transaction(async (tx) => {
      if (dto.operationId) {
        const cached = await this.findCachedOperation<TaskMutationResult>(
          tx,
          userId,
          dto.operationId,
        );
        if (cached) return cached;
      }

      // The check above is only a fast-path: a concurrent request could have
      // mutated the row in between. Re-run the version check as part of the
      // WHERE clause of the write itself so it's atomic — under Postgres
      // READ COMMITTED, a concurrent UPDATE targeting the same row blocks on
      // the row lock and re-evaluates WHERE once the lock is released, so a
      // stale `baseVersion` can never sneak through. This is the
      // server-ordered LWW: whichever UPDATE's WHERE matches first (i.e.
      // whichever transaction the DB lets proceed/commit first) wins, and
      // every later one re-checks against the now-current row and conflicts.
      const where: Prisma.TaskWhereInput =
        dto.baseVersion !== undefined ? { id: taskId, version: dto.baseVersion } : { id: taskId };
      const { count } = await tx.task.updateMany({ where, data });

      if (count === 0) {
        const current = await tx.task.findUnique({ where: { id: taskId } });
        if (!current) {
          throw new NotFoundException('Task not found');
        }
        throw new ConflictException({
          message: 'Task was modified by someone else',
          code: 'VERSION_CONFLICT',
          currentTask: current,
        });
      }

      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      const listVersion = await this.bumpListVersion(tx, existing.listId);
      const result: TaskMutationResult = { task, listVersion };

      if (dto.operationId) {
        await this.storeOperationResult(tx, userId, dto.operationId, result);
      }

      return result;
    });
  }

  async deleteTask(
    taskId: string,
    userId: string,
    force: boolean,
    operationId?: string,
  ): Promise<{ taskId: string; listId: string; listVersion: number }> {
    // Checked before `loadTaskOrThrow`, unlike every other mutation: a
    // successful delete's defining side effect is that the row is gone, so
    // a replay of it (offline-queue or otherwise) hitting `loadTaskOrThrow`
    // first would always 404 before ever reaching the cache and could never
    // return its cached success — the one case idempotency exists for.
    if (operationId) {
      const cached = await this.findCachedOperation<{
        taskId: string;
        listId: string;
        listVersion: number;
      }>(this.prisma, userId, operationId);
      if (cached) return cached;
    }

    const task = await this.loadTaskOrThrow(taskId);
    const membership = await this.membership.requireMembership(task.listId, userId);

    const isAdmin = membership.role === ListRole.ADMIN;
    const isOwnTask = task.createdById === userId;

    if (!isAdmin && !isOwnTask) {
      throw new ForbiddenException('You can only delete tasks you created');
    }

    // Hard rule, never bypassable by `force`: a member can never delete a
    // completed task, regardless of who is editing it.
    if (task.completed && !isAdmin) {
      throw new ForbiddenException('Only an admin can delete a completed task');
    }

    if (!force) {
      const reasons: string[] = [];
      if (task.completed) reasons.push('COMPLETED');

      const editedBy = this.presence.getEditors(task.listId, taskId, userId);
      if (editedBy.length > 0) reasons.push('BEING_EDITED');

      if (reasons.length > 0) {
        throw new BadRequestException({
          message: 'Deleting this task requires confirmation',
          code: 'CONFIRMATION_REQUIRED',
          reasons,
          editedBy,
          task,
        });
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (operationId) {
        const cached = await this.findCachedOperation<{
          taskId: string;
          listId: string;
          listVersion: number;
        }>(tx, userId, operationId);
        if (cached) return cached;
      }

      // Server-side re-check right before the actual delete: the checks
      // above ran against a read taken before the transaction, so a
      // concurrent change (task completed, task un-owned, task already
      // deleted) between that read and here must not silently succeed or
      // silently no-op incorrectly. The conditional deleteMany's WHERE
      // encodes the same authorization rule; if 0 rows match, we re-derive
      // the precise reason from a fresh read instead of assuming success.
      const where: Prisma.TaskWhereInput = isAdmin
        ? force
          ? { id: taskId }
          : { id: taskId, completed: false }
        : { id: taskId, createdById: userId, completed: false };

      const { count } = await tx.task.deleteMany({ where });

      if (count === 0) {
        const current = await tx.task.findUnique({ where: { id: taskId } });
        if (!current) {
          // Already deleted (e.g. a racing delete, or a replayed/duplicate
          // request). Idempotent no-op from the caller's point of view —
          // the task is gone either way, so surface it as NotFound rather
          // than re-creating or otherwise resurrecting anything.
          throw new NotFoundException('Task not found');
        }
        if (!isAdmin) {
          if (current.createdById !== userId) {
            throw new ForbiddenException('You can only delete tasks you created');
          }
          throw new ForbiddenException('Only an admin can delete a completed task');
        }
        throw new BadRequestException({
          message: 'Deleting a completed task requires confirmation',
          code: 'CONFIRMATION_REQUIRED',
          reasons: ['COMPLETED'],
          task: current,
        });
      }

      const listVersion = await this.bumpListVersion(tx, task.listId);
      const result = { taskId, listId: task.listId, listVersion };

      if (operationId) {
        await this.storeOperationResult(tx, userId, operationId, result);
      }

      return result;
    });
  }

  async reorderTask(
    taskId: string,
    userId: string,
    dto: { beforeId?: string; afterId?: string; baseVersion?: number; operationId?: string },
  ): Promise<TaskMutationResult> {
    const existing = await this.loadTaskOrThrow(taskId);
    await this.membership.requireMembership(existing.listId, userId);

    // Fast path: skip the lock/transaction entirely for an already-recorded
    // replay. A narrower race (two first attempts of the same operationId
    // landing at nearly the same time) is still closed inside the
    // transaction below, after the lock is held.
    if (dto.operationId) {
      const cached = await this.findCachedOperation<TaskMutationResult>(
        this.prisma,
        userId,
        dto.operationId,
      );
      if (cached) return cached;
    }

    if (dto.beforeId === taskId || dto.afterId === taskId) {
      throw new BadRequestException('A task cannot be reordered relative to itself');
    }

    const listId = existing.listId;

    return this.prisma.$transaction(async (tx) => {
      await this.acquireListLock(tx, listId);

      if (dto.operationId) {
        const cached = await this.findCachedOperation<TaskMutationResult>(
          tx,
          userId,
          dto.operationId,
        );
        if (cached) return cached;
      }

      // Re-read everything fresh inside the lock: the pre-lock reads above
      // (and any beforeId/afterId the client sent) may already be stale by
      // the time we get the lock, since another reorder — on this or any
      // other backend instance — could have run while we were queued.
      const current = await tx.task.findUnique({ where: { id: taskId } });
      if (!current) {
        throw new NotFoundException('Task not found');
      }

      if (dto.baseVersion !== undefined && dto.baseVersion !== current.version) {
        throw new ConflictException({
          message: 'Task was modified by someone else',
          code: 'VERSION_CONFLICT',
          currentTask: current,
        });
      }

      const [beforeTask, afterTask] = await Promise.all([
        dto.beforeId ? tx.task.findUnique({ where: { id: dto.beforeId } }) : null,
        dto.afterId ? tx.task.findUnique({ where: { id: dto.afterId } }) : null,
      ]);

      if (dto.beforeId && (!beforeTask || beforeTask.listId !== listId)) {
        throw new BadRequestException('Invalid beforeId');
      }
      if (dto.afterId && (!afterTask || afterTask.listId !== listId)) {
        throw new BadRequestException('Invalid afterId');
      }

      let position: string;
      try {
        position = generateKeyBetween(beforeTask?.position ?? null, afterTask?.position ?? null);
      } catch {
        throw new BadRequestException('beforeId and afterId are not adjacent in the current order');
      }

      if (position.length > MAX_POSITION_LENGTH) {
        await this.rebalanceListPositions(tx, listId);
        const [rbBefore, rbAfter] = await Promise.all([
          dto.beforeId ? tx.task.findUnique({ where: { id: dto.beforeId } }) : null,
          dto.afterId ? tx.task.findUnique({ where: { id: dto.afterId } }) : null,
        ]);
        position = generateKeyBetween(rbBefore?.position ?? null, rbAfter?.position ?? null);
      }

      const data: Prisma.TaskUncheckedUpdateManyInput = {
        position,
        version: { increment: 1 },
        lastEditedById: userId,
      };

      // Same atomic version-conditioned write as updateTask — see comment
      // there. The neighbor race that used to exist here (reading
      // before/after outside any lock) is closed by the advisory lock above:
      // no other position-affecting operation on this list, on this or any
      // other backend instance, can interleave between the reads above and
      // this write. Equal ranks can still occur by legitimate coincidence
      // (e.g. two inserts anchored to the same single-sided neighbor) and
      // are resolved deterministically by the (position, id) orderBy used
      // everywhere tasks are listed.
      const where: Prisma.TaskWhereInput =
        dto.baseVersion !== undefined
          ? { id: taskId, version: dto.baseVersion }
          : { id: taskId, version: current.version };
      const { count } = await tx.task.updateMany({ where, data });

      if (count === 0) {
        const c = await tx.task.findUnique({ where: { id: taskId } });
        if (!c) {
          throw new NotFoundException('Task not found');
        }
        throw new ConflictException({
          message: 'Task was modified by someone else',
          code: 'VERSION_CONFLICT',
          currentTask: c,
        });
      }

      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      const listVersion = await this.bumpListVersion(tx, listId);
      const result: TaskMutationResult = { task, listVersion };

      if (dto.operationId) {
        await this.storeOperationResult(tx, userId, dto.operationId, result);
      }

      return result;
    });
  }
}
