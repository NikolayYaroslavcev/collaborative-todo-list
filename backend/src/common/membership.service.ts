import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ListMember, ListRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MembershipService {
  constructor(private readonly prisma: PrismaService) {}

  async getMembership(listId: string, userId: string): Promise<ListMember | null> {
    return this.prisma.listMember.findUnique({
      where: { listId_userId: { listId, userId } },
    });
  }

  /** Throws if the list does not exist or the user is not a member of it. */
  async requireMembership(listId: string, userId: string): Promise<ListMember> {
    const list = await this.prisma.list.findUnique({ where: { id: listId } });
    if (!list) {
      throw new NotFoundException('List not found');
    }

    const membership = await this.getMembership(listId, userId);
    if (!membership) {
      throw new ForbiddenException('You are not a member of this list');
    }

    return membership;
  }

  /** Throws unless the user is an ADMIN member of the list. */
  async requireAdmin(listId: string, userId: string): Promise<ListMember> {
    const membership = await this.requireMembership(listId, userId);
    if (membership.role !== ListRole.ADMIN) {
      throw new ForbiddenException('Admin role required');
    }
    return membership;
  }
}
