import { describe, expect, it } from 'vitest';
import { createBid, createUser } from './helpers.js';

/**
 * Dates are the easiest thing to get quietly wrong here: a `DATE` column read
 * back through a driver that applies the server's timezone shifts every bid by
 * a day for half the world. These tests go through real HTTP and a real
 * Postgres, so a shift shows up as a failure rather than as a user complaint.
 */
describe('date round-tripping', () => {
  it('returns bidDate exactly as sent', async () => {
    const user = await createUser();

    for (const bidDate of ['2026-01-01', '2026-06-15', '2026-12-31']) {
      const bid = await createBid(user, { bidDate });
      expect(bid.bidDate).toBe(bidDate);
    }
  });

  it('does not shift a date across a midnight boundary', async () => {
    const user = await createUser();
    // 1 Jan is the canonical off-by-one: a negative UTC offset rolls it back
    // into the previous year.
    const bid = await createBid(user, { bidDate: '2026-01-01' });

    const refetched = await user.agent.get(`/api/bids/${bid.id}`).expect(200);
    expect(refetched.body.bidDate).toBe('2026-01-01');
  });

  it('preserves an interview time as naive local wall-clock', async () => {
    const user = await createUser();

    const bid = await createBid(user, {
      status: 'Interview (Round 3)',
      interviews: [{ stage: 'Interview (Round 3)', dateTime: '2026-07-04T23:30:00' }],
    });

    // No `Z`, no offset applied — 23:30 stays 23:30, and stays on the 4th.
    expect(bid.interviews?.[0]?.dateTime).toBe('2026-07-04T23:30:00');
  });

  it('accepts an interview time without seconds and normalises it', async () => {
    const user = await createUser();

    const bid = await createBid(user, {
      status: 'Final Interview',
      interviews: [{ stage: 'Final Interview', dateTime: '2026-07-04T09:00' }],
    });

    expect(bid.interviews?.[0]?.dateTime).toBe('2026-07-04T09:00:00');
  });

  it('reports createdAt and updatedAt as true instants', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    expect(bid.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(bid.updatedAt).toMatch(/Z$/);
  });

  it('advances updatedAt on a write but leaves createdAt alone', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    const updated = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ notes: 'touched' })
      .expect(200);

    expect(updated.body.createdAt).toBe(bid.createdAt);
    expect(new Date(updated.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(bid.updatedAt).getTime(),
    );
  });

  it('rejects a date that is not YYYY-MM-DD', async () => {
    const user = await createUser();

    for (const bidDate of ['01/03/2026', '2026-3-1', 'yesterday', '2026-13-01']) {
      await user.agent.post('/api/bids').send({
        company: 'Acme',
        role: 'Dev',
        location: 'Remote',
        status: 'Applied',
        bidDate,
      }).expect(400);
    }
  });
});
