import { PrismaClient, ListRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { generateNKeysBetween } from 'fractional-indexing';

const prisma = new PrismaClient();

const SEED_PASSWORD = 'password123';

async function main() {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      name: 'Admin',
      passwordHash,
    },
  });

  const member = await prisma.user.upsert({
    where: { email: 'member@example.com' },
    update: {},
    create: {
      email: 'member@example.com',
      name: 'Member',
      passwordHash,
    },
  });

  const existingList = await prisma.list.findFirst({ where: { title: 'Demo List' } });
  const list =
    existingList ??
    (await prisma.list.create({
      data: { title: 'Demo List', ownerId: admin.id },
    }));

  await prisma.listMember.upsert({
    where: { listId_userId: { listId: list.id, userId: admin.id } },
    update: {},
    create: { listId: list.id, userId: admin.id, role: ListRole.ADMIN },
  });

  await prisma.listMember.upsert({
    where: { listId_userId: { listId: list.id, userId: member.id } },
    update: {},
    create: { listId: list.id, userId: member.id, role: ListRole.MEMBER },
  });

  const existingTasks = await prisma.task.count({ where: { listId: list.id } });
  if (existingTasks === 0) {
    const titles = ['Set up project', 'Write README', 'Invite teammate'];
    const positions = generateNKeysBetween(null, null, titles.length);

    for (let i = 0; i < titles.length; i++) {
      await prisma.task.create({
        data: {
          listId: list.id,
          title: titles[i],
          position: positions[i],
          createdById: admin.id,
          lastEditedById: admin.id,
        },
      });
    }
  }

  console.log('Seed complete.');
  console.log(`  admin@example.com / ${SEED_PASSWORD}`);
  console.log(`  member@example.com / ${SEED_PASSWORD}`);
  console.log(`  Demo list: ${list.id}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
