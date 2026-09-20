import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupFixtures } from '../src/test-utils/fixtures';

describe('REST flows (e2e): auth, lists, invites, tasks, permissions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const userIds: string[] = [];
  const listIds: string[] = [];

  const PASSWORD = 'password123';

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await cleanupFixtures(prisma, { listIds, userIds });
    await app.close();
  });

  async function makeUser(namePrefix: string) {
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const user = await prisma.user.create({
      data: {
        email: `${namePrefix}-${Date.now()}-${Math.random()}@test.local`,
        name: namePrefix,
        passwordHash,
      },
    });
    userIds.push(user.id);
    return user;
  }

  async function login(email: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  it('rejects a wrong password with 401, and issues a token for the right one', async () => {
    const user = await makeUser('login-user');

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: 'wrong-password' })
      .expect(401);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user.email).toBe(user.email);
  });

  it('rejects unauthenticated requests to protected endpoints', async () => {
    await request(app.getHttpServer()).get('/lists').expect(401);
  });

  it('full list lifecycle: create, appears in GET /lists, delete', async () => {
    const owner = await makeUser('owner');
    const token = await login(owner.email);

    const create = await request(app.getHttpServer())
      .post('/lists')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'My REST list' })
      .expect(201);
    listIds.push(create.body.id);

    const list = await request(app.getHttpServer())
      .get('/lists')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: create.body.id, role: 'ADMIN' })]),
    );
    expect(list.body).toEqual(
      expect.objectContaining({ page: 1, pageSize: 20, total: expect.any(Number) }),
    );

    await request(app.getHttpServer())
      .delete(`/lists/${create.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const afterDelete = await request(app.getHttpServer())
      .get('/lists')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterDelete.body.items.some((l: any) => l.id === create.body.id)).toBe(false);
  });

  it('GET /lists paginates with page/pageSize query params', async () => {
    const owner = await makeUser('paginator');
    const token = await login(owner.email);

    for (let i = 0; i < 3; i++) {
      const created = await request(app.getHttpServer())
        .post('/lists')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: `Page test list ${i}` })
        .expect(201);
      listIds.push(created.body.id);
    }

    const firstPage = await request(app.getHttpServer())
      .get('/lists?page=1&pageSize=2')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body).toEqual(
      expect.objectContaining({ page: 1, pageSize: 2, total: 3, totalPages: 2 }),
    );

    const secondPage = await request(app.getHttpServer())
      .get('/lists?page=2&pageSize=2')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(secondPage.body.items).toHaveLength(1);

    const firstPageIds = firstPage.body.items.map((l: any) => l.id);
    const secondPageIds = secondPage.body.items.map((l: any) => l.id);
    expect(firstPageIds.some((id: string) => secondPageIds.includes(id))).toBe(false);
  });

  it('invite flow: admin creates an invite link, a second user accepts it and gains membership', async () => {
    const admin = await makeUser('inviter');
    const invitee = await makeUser('invitee');
    const adminToken = await login(admin.email);
    const inviteeToken = await login(invitee.email);

    const list = await request(app.getHttpServer())
      .post('/lists')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Invite-only list' })
      .expect(201);
    listIds.push(list.body.id);

    const invite = await request(app.getHttpServer())
      .post(`/lists/${list.body.id}/invite`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);
    expect(invite.body.token).toEqual(expect.any(String));
    // The invite link must point at the frontend's accept page
    // (`/invites/[token]`), not at the backend's own API route
    // (`/invites/:token/accept`) — sharing the raw API URL 404s in the
    // browser since no such page exists.
    expect(invite.body.url).toBe(`${process.env.FRONTEND_URL}/invites/${invite.body.token}`);

    // Before accepting, the invitee has no access.
    await request(app.getHttpServer())
      .get(`/lists/${list.body.id}`)
      .set('Authorization', `Bearer ${inviteeToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/invites/${invite.body.token}/accept`)
      .set('Authorization', `Bearer ${inviteeToken}`)
      .expect(201)
      .expect((res: request.Response) => {
        expect(res.body).toMatchObject({ listId: list.body.id, role: 'MEMBER' });
      });

    await request(app.getHttpServer())
      .get(`/lists/${list.body.id}`)
      .set('Authorization', `Bearer ${inviteeToken}`)
      .expect(200);
  });

  it('task CRUD over REST, with baseVersion optimistic concurrency', async () => {
    const owner = await makeUser('task-owner');
    const token = await login(owner.email);
    const list = await request(app.getHttpServer())
      .post('/lists')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Task REST list' })
      .expect(201);
    listIds.push(list.body.id);

    const created = await request(app.getHttpServer())
      .post(`/lists/${list.body.id}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'REST task' })
      .expect(201);
    const task = created.body.task;

    const listed = await request(app.getHttpServer())
      .get(`/lists/${list.body.id}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listed.body.map((t: any) => t.id)).toContain(task.id);

    await request(app.getHttpServer())
      .patch(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ completed: true, baseVersion: task.version })
      .expect(200);

    // Stale baseVersion now (it was already bumped by the update above).
    await request(app.getHttpServer())
      .patch(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'stale', baseVersion: task.version })
      .expect(409);

    await request(app.getHttpServer())
      .delete(`/tasks/${task.id}?force=true`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('a member cannot delete a task created by someone else via REST (403)', async () => {
    const admin = await makeUser('rest-admin');
    const member = await makeUser('rest-member');
    const adminToken = await login(admin.email);
    const memberToken = await login(member.email);

    const list = await request(app.getHttpServer())
      .post('/lists')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Permission REST list' })
      .expect(201);
    listIds.push(list.body.id);

    const invite = await request(app.getHttpServer())
      .post(`/lists/${list.body.id}/invite`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);
    await request(app.getHttpServer())
      .post(`/invites/${invite.body.token}/accept`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(201);

    const task = await request(app.getHttpServer())
      .post(`/lists/${list.body.id}/tasks`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Admin-owned task' })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/tasks/${task.body.task.id}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(403);
  });
});
