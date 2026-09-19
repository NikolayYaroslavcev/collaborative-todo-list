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
import { generateKeyBetween } from '../common/fractional-index';

export interface TaskMutationResult {
  task: Task;
  listVersion: number;
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
  ) {}

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

  async createTask(listId: string, userId: string, title: string): Promise<TaskMutationResult> {
    await this.membership.requireMembership(listId, userId);

    return this.prisma.$transaction(async (tx) => {
      const last = await tx.task.findFirst({
        where: { listId },
        orderBy: [{ position: 'desc' }],
      });
      const position = generateKeyBetween(last?.position ?? null, null);

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
      return { task, listVersion };
    });
  }

  async updateTask(
    taskId: string,
    userId: string,
    dto: { title?: string; completed?: boolean; baseVersion?: number },
  ): Promise<TaskMutationResult> {
    const existing = await this.loadTaskOrThrow(taskId);
    await this.membership.requireMembership(existing.listId, userId);

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
      // The check above is only a fast-path: a concurrent request could have
      // mutated the row in between. Re-run the version check as part of the
      // WHERE clause of the write itself so it's atomic — under Postgres
      // READ COMMITTED, a concurrent UPDATE targeting the same row blocks on
      // the row lock and re-evaluates WHERE once the lock is released, so a
      // stale `baseVersion` can never sneak through.
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
      return { task, listVersion };
    });
  }

  async deleteTask(
    taskId: string,
    userId: string,
    force: boolean,
  ): Promise<{ taskId: string; listId: string; listVersion: number }> {
    const task = await this.loadTaskOrThrow(taskId);
    const membership = await this.membership.requireMembership(task.listId, userId);

    const isAdmin = membership.role === ListRole.ADMIN;
    const isOwnTask = task.createdById === userId;

    if (!isAdmin && !isOwnTask) {
      throw new ForbiddenException('You can only delete tasks you created');
    }

    // Fast-path rejection using the state we just read. The authoritative
    // check is the WHERE clause below — if the task's completed/ownership
    // state changes concurrently between this read and the delete, the
    // conditional deleteMany matches 0 rows and we re-derive the correct
    // error from a fresh read instead of silently deleting something that
    // no longer satisfies the rule (or crashing on a double-delete).
    if (task.completed) {
      if (!isAdmin) {
        throw new ForbiddenException('Only an admin can delete a completed task');
      }
      if (!force) {
        throw new BadRequestException({
          message: 'Deleting a completed task requires confirmation',
          code: 'CONFIRMATION_REQUIRED',
        });
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const where: Prisma.TaskWhereInput = isAdmin
        ? force
          ? { id: taskId }
          : { id: taskId, completed: false }
        : { id: taskId, createdById: userId, completed: false };

      const { count } = await tx.task.deleteMany({ where });

      if (count === 0) {
        const current = await tx.task.findUnique({ where: { id: taskId } });
        if (!current) {
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
        });
      }

      const listVersion = await this.bumpListVersion(tx, task.listId);
      return { taskId, listId: task.listId, listVersion };
    });
  }

  async reorderTask(
    taskId: string,
    userId: string,
    dto: { beforeId?: string; afterId?: string; baseVersion?: number },
  ): Promise<TaskMutationResult> {
    const existing = await this.loadTaskOrThrow(taskId);
    await this.membership.requireMembership(existing.listId, userId);

    if (dto.baseVersion !== undefined && dto.baseVersion !== existing.version) {
      throw new ConflictException({
        message: 'Task was modified by someone else',
        code: 'VERSION_CONFLICT',
        currentTask: existing,
      });
    }

    if (dto.beforeId === taskId || dto.afterId === taskId) {
      throw new BadRequestException('A task cannot be reordered relative to itself');
    }

    const [beforeTask, afterTask] = await Promise.all([
      dto.beforeId ? this.prisma.task.findUnique({ where: { id: dto.beforeId } }) : null,
      dto.afterId ? this.prisma.task.findUnique({ where: { id: dto.afterId } }) : null,
    ]);

    if (dto.beforeId && (!beforeTask || beforeTask.listId !== existing.listId)) {
      throw new BadRequestException('Invalid beforeId');
    }
    if (dto.afterId && (!afterTask || afterTask.listId !== existing.listId)) {
      throw new BadRequestException('Invalid afterId');
    }

    let position: string;
    try {
      position = generateKeyBetween(beforeTask?.position ?? null, afterTask?.position ?? null);
    } catch {
      throw new BadRequestException('beforeId and afterId are not adjacent in the current order');
    }

    const data: Prisma.TaskUncheckedUpdateManyInput = {
      position,
      version: { increment: 1 },
      lastEditedById: userId,
    };

    return this.prisma.$transaction(async (tx) => {
      // Same atomic version-conditioned write as updateTask — see comment there.
      // Note: beforeTask/afterTask were read outside this transaction, so a
      // neighbor moving concurrently between that read and this write can
      // still produce a stale-but-valid position; fully closing that race
      // (re-deriving neighbors inside the same transaction, tie-breaking
      // on identical ranks under concurrent inserts) is Этап 8 scope.
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
      return { task, listVersion };
    });
  }
}
