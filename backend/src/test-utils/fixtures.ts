import { ListRole, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

/** Test-only helpers for building isolated fixtures against a real
 *  Postgres database (see backend/.env.test). Every user/list created here
 *  gets a random-UUID-suffixed identifier so parallel test files never
 *  collide, and `cleanupFixtures` tears down exactly what a given test
 *  created. */

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@test.local`;
}

export async function createUser(prisma: PrismaClient, namePrefix: string) {
  return prisma.user.create({
    data: {
      email: uniqueEmail(namePrefix),
      name: namePrefix,
      passwordHash: 'unused-in-tests',
    },
  });
}

export async function createListWithMembers(
  prisma: PrismaClient,
  ownerId: string,
  members: { userId: string; role: ListRole }[] = [],
) {
  return prisma.$transaction(async (tx) => {
    const list = await tx.list.create({ data: { title: `Test list ${randomUUID()}`, ownerId } });
    await tx.listMember.create({
      data: { listId: list.id, userId: ownerId, role: ListRole.ADMIN },
    });
    for (const m of members) {
      await tx.listMember.create({ data: { listId: list.id, userId: m.userId, role: m.role } });
    }
    return list;
  });
}

export async function cleanupFixtures(
  prisma: PrismaClient,
  ids: { listIds?: string[]; userIds?: string[] },
) {
  if (ids.listIds?.length) {
    await prisma.list.deleteMany({ where: { id: { in: ids.listIds } } });
  }
  if (ids.userIds?.length) {
    await prisma.user.deleteMany({ where: { id: { in: ids.userIds } } });
  }
}
