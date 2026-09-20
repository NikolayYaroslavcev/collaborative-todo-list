import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ListRole } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipService } from '../common/membership.service';

@Injectable()
export class ListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
  ) {}

  async findAllForUser(userId: string, page = 1, pageSize = 20) {
    const [memberships, total] = await Promise.all([
      this.prisma.listMember.findMany({
        where: { userId },
        include: {
          list: {
            include: {
              _count: { select: { members: true, tasks: true } },
            },
          },
        },
        orderBy: { list: { createdAt: 'asc' } },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.listMember.count({ where: { userId } }),
    ]);

    return {
      items: memberships.map((m) => ({
        id: m.list.id,
        title: m.list.title,
        ownerId: m.list.ownerId,
        version: m.list.version,
        createdAt: m.list.createdAt,
        updatedAt: m.list.updatedAt,
        role: m.role,
        memberCount: m.list._count.members,
        taskCount: m.list._count.tasks,
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async createList(userId: string, title: string) {
    return this.prisma.$transaction(async (tx) => {
      const list = await tx.list.create({
        data: { title, ownerId: userId },
      });
      await tx.listMember.create({
        data: { listId: list.id, userId, role: ListRole.ADMIN },
      });
      return list;
    });
  }

  async deleteList(listId: string, userId: string) {
    await this.membership.requireAdmin(listId, userId);
    await this.prisma.list.delete({ where: { id: listId } });
    return { id: listId };
  }

  /** Full state used for WS list:sync and for REST detail views. */
  async getListSnapshot(listId: string, userId: string) {
    await this.membership.requireMembership(listId, userId);

    const list = await this.prisma.list.findUnique({ where: { id: listId } });
    if (!list) {
      throw new NotFoundException('List not found');
    }

    const [members, tasks] = await Promise.all([
      this.prisma.listMember.findMany({
        where: { listId },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.task.findMany({
        where: { listId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      }),
    ]);

    return {
      list,
      members: members.map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
      })),
      tasks,
      version: list.version,
    };
  }

  async createInvite(
    listId: string,
    userId: string,
    role: ListRole = ListRole.MEMBER,
    expiresInHours?: number,
  ) {
    await this.membership.requireAdmin(listId, userId);

    const token = randomBytes(24).toString('hex');
    const expiresAt = expiresInHours
      ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
      : null;

    const invite = await this.prisma.invite.create({
      data: {
        token,
        listId,
        role,
        createdById: userId,
        expiresAt,
      },
    });

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    return {
      token: invite.token,
      role: invite.role,
      expiresAt: invite.expiresAt,
      url: `${frontendUrl}/invites/${invite.token}`,
    };
  }

  async acceptInvite(token: string, userId: string) {
    const invite = await this.prisma.invite.findUnique({ where: { token } });
    if (!invite || invite.revokedAt) {
      throw new NotFoundException('Invite not found');
    }
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Invite has expired');
    }

    const membership = await this.prisma.$transaction(async (tx) => {
      // upsert (not findUnique-then-create) so two concurrent accepts by the
      // same user can't race on the listId+userId unique constraint.
      const member = await tx.listMember.upsert({
        where: { listId_userId: { listId: invite.listId, userId } },
        update: {},
        create: { listId: invite.listId, userId, role: invite.role },
      });

      await tx.invite.update({
        where: { id: invite.id },
        data: { lastUsedAt: new Date(), lastUsedById: userId },
      });

      return member;
    });

    return { listId: invite.listId, role: membership.role };
  }
}
