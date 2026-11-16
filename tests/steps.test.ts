import { describe, expect, it } from 'vitest';
import { createBid, createUser } from './helpers.js';

/** Interview steps — the Pipeline drawer — and archiving from the board. */
describe('interview steps', () => {
  it('adds steps in order, scheduled or "TBD", and returns them on the bid', async () => {
    const user = await createUser();
    const bid = await createBid(user, { company: 'Fivetran', status: 'Screening (Round 1)' });
    expect(bid.steps).toEqual([]);

    await user.agent.post(`/api/bids/${bid.id}/steps`).send({ type: 'Recruiter Screen', companyName: 'Fivetran' }).expect(201);
    const second = await user.agent
      .post(`/api/bids/${bid.id}/steps`)
      .send({
        type: 'Hiring Manager',
        scheduledAt: '2026-10-12T14:00:00',
        timezone: 'America/New_York',
        durationMinutes: 45,
        details: 'With Dana, the EM.',
      })
      .expect(201);

    const steps = second.body.steps;
    expect(steps.map((step: { type: string }) => step.type)).toEqual(['Recruiter Screen', 'Hiring Manager']);
    expect(steps[0]).toMatchObject({ companyName: 'Fivetran', position: 0, files: [] });
    expect(steps[0].scheduledAt).toBeUndefined();
    expect(steps[1]).toMatchObject({
      position: 1,
      scheduledAt: '2026-10-12T14:00:00',
      timezone: 'America/New_York',
      durationMinutes: 45,
      details: 'With Dana, the EM.',
    });

    // On the list too: the board draws every card's steps.
    const list = await user.agent.get('/api/bids').expect(200);
    expect(list.body[0].steps).toHaveLength(2);
  });

  it('edits and deletes a step', async () => {
    const user = await createUser();
    const bid = await createBid(user);
    const created = await user.agent.post(`/api/bids/${bid.id}/steps`).send({ type: 'Technical' }).expect(201);
    const stepId = created.body.steps[0].id;

    const edited = await user.agent
      .patch(`/api/bids/${bid.id}/steps/${stepId}`)
      .send({ type: 'Coding', scheduledAt: '2026-10-20T09:30:00' })
      .expect(200);
    expect(edited.body.steps[0]).toMatchObject({ type: 'Coding', scheduledAt: '2026-10-20T09:30:00' });

    // Clearing the time makes it "TBD" again.
    const cleared = await user.agent.patch(`/api/bids/${bid.id}/steps/${stepId}`).send({ scheduledAt: null }).expect(200);
    expect(cleared.body.steps[0].scheduledAt).toBeUndefined();

    const deleted = await user.agent.delete(`/api/bids/${bid.id}/steps/${stepId}`).expect(200);
    expect(deleted.body.steps).toEqual([]);
  });

  it('refuses an unknown step type and a malformed time', async () => {
    const user = await createUser();
    const bid = await createBid(user);
    await user.agent.post(`/api/bids/${bid.id}/steps`).send({ type: 'Lunch' }).expect(400);
    await user.agent.post(`/api/bids/${bid.id}/steps`).send({ type: 'Onsite', scheduledAt: 'tomorrow' }).expect(400);
  });

  it("keeps another account's steps out of reach", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const bid = await createBid(owner);
    const created = await owner.agent.post(`/api/bids/${bid.id}/steps`).send({ type: 'Onsite' }).expect(201);
    const stepId = created.body.steps[0].id;

    await stranger.agent.post(`/api/bids/${bid.id}/steps`).send({ type: 'Onsite' }).expect(404);
    await stranger.agent.patch(`/api/bids/${bid.id}/steps/${stepId}`).send({ type: 'Final' }).expect(404);
    await stranger.agent.delete(`/api/bids/${bid.id}/steps/${stepId}`).expect(404);
  });

  it('attaches, downloads and removes a file', async () => {
    const user = await createUser();
    const bid = await createBid(user);
    const created = await user.agent.post(`/api/bids/${bid.id}/steps`).send({ type: 'System Design' }).expect(201);
    const stepId = created.body.steps[0].id;

    const uploaded = await user.agent
      .post(`/api/bids/${bid.id}/steps/${stepId}/files`)
      .attach('file', Buffer.from('Design a URL shortener.'), { filename: 'brief.txt', contentType: 'text/plain' })
      .expect(201);
    const file = uploaded.body.steps[0].files[0];
    expect(file).toMatchObject({ name: 'brief.txt', contentType: 'text/plain', size: 23 });

    const download = await user.agent.get(`/api/bids/${bid.id}/steps/${stepId}/files/${file.id}`).expect(200);
    expect(download.headers['content-disposition']).toContain('brief.txt');
    expect(download.text).toBe('Design a URL shortener.');

    const removed = await user.agent.delete(`/api/bids/${bid.id}/steps/${stepId}/files/${file.id}`).expect(200);
    expect(removed.body.steps[0].files).toEqual([]);
  });

  it('moves the version, so open pages refresh', async () => {
    const user = await createUser();
    const bid = await createBid(user);
    const before = (await user.agent.get('/api/bids/version').expect(200)).body.version;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await user.agent.post(`/api/bids/${bid.id}/steps`).send({ type: 'Behavioral' }).expect(201);
    expect((await user.agent.get('/api/bids/version').expect(200)).body.version).not.toBe(before);
  });
});

describe('archiving', () => {
  it('archives and restores an application', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    const archived = await user.agent.patch(`/api/bids/${bid.id}`).send({ archived: true }).expect(200);
    expect(typeof archived.body.archivedAt).toBe('string');

    const restored = await user.agent.patch(`/api/bids/${bid.id}`).send({ archived: false }).expect(200);
    expect(restored.body.archivedAt).toBeUndefined();
  });
});
