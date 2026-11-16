import { describe, expect, it } from 'vitest';
import { createAdmin, createUser, request } from './helpers.js';

describe('notifications', () => {
  it('requires authentication', async () => {
    await request().get('/api/notifications').expect(401);
    await request()
      .post('/api/notifications')
      .send({ title: 'Hello', message: 'World', toAdmins: true })
      .expect(401);
  });

  it('lets an admin notify selected users and keeps recipients isolated', async () => {
    const admin = await createAdmin();
    const recipient = await createUser();
    const other = await createUser();

    const sent = await admin.agent
      .post('/api/notifications')
      .send({
        title: 'Application update',
        message: 'Your application moved to interview.',
        link: '/applications',
        recipientIds: [recipient.id],
      })
      .expect(201);
    expect(sent.body).toEqual({ delivered: 1 });

    const inbox = await recipient.agent.get('/api/notifications').expect(200);
    expect(inbox.body.unreadCount).toBe(1);
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0]).toMatchObject({
      title: 'Application update',
      link: '/applications',
      sender: { id: admin.id, email: admin.email },
    });

    const emptyInbox = await other.agent.get('/api/notifications').expect(200);
    expect(emptyInbox.body).toEqual({ items: [], unreadCount: 0 });
  });

  it('lets users message administrators but not arbitrary users', async () => {
    const admin = await createAdmin();
    const sender = await createUser();
    const other = await createUser();

    await sender.agent
      .post('/api/notifications')
      .send({ title: 'Need help', message: 'Please review my application.', toAdmins: true })
      .expect(201);

    const adminInbox = await admin.agent.get('/api/notifications').expect(200);
    expect(adminInbox.body.items[0]).toMatchObject({
      title: 'Need help',
      sender: { id: sender.id, email: sender.email },
    });

    await sender.agent
      .post('/api/notifications')
      .send({ title: 'No', message: 'Not allowed', recipientIds: [other.id] })
      .expect(403);
  });

  it('broadcasts independently and supports read one/read all', async () => {
    const admin = await createAdmin();
    const first = await createUser();
    const second = await createUser();

    await admin.agent
      .post('/api/notifications')
      .send({ title: 'Notice 1', message: 'First notice', broadcast: true })
      .expect(201);
    await admin.agent
      .post('/api/notifications')
      .send({ title: 'Notice 2', message: 'Second notice', broadcast: true })
      .expect(201);

    const before = await first.agent.get('/api/notifications').expect(200);
    expect(before.body.unreadCount).toBe(2);

    await first.agent
      .post(`/api/notifications/${before.body.items[0].id}/read`)
      .expect(204);
    expect((await first.agent.get('/api/notifications')).body.unreadCount).toBe(1);

    const readAll = await first.agent.post('/api/notifications/read-all').expect(200);
    expect(readAll.body).toEqual({ updated: 1 });
    expect((await first.agent.get('/api/notifications')).body.unreadCount).toBe(0);
    expect((await second.agent.get('/api/notifications')).body.unreadCount).toBe(2);
  });

  it('rejects external links', async () => {
    const admin = await createAdmin();
    const recipient = await createUser();
    await admin.agent
      .post('/api/notifications')
      .send({
        title: 'Unsafe',
        message: 'Do not allow external destinations.',
        link: 'https://example.com',
        recipientIds: [recipient.id],
      })
      .expect(400);
  });
});
