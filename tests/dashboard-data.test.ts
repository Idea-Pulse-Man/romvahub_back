import { describe, expect, it } from 'vitest';
import { createAdmin, createBid, createUser } from './helpers.js';

/** Today in UTC, which is the frame the dashboard uses with tzOffset=0. */
function isoDay(daysAgo = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

describe('GET /api/dashboard', () => {
  it('counts every status, including the zeroes the pie chart needs', async () => {
    const user = await createUser();
    await createBid(user, { status: 'Applied' });
    await createBid(user, { status: 'Applied' });
    await createBid(user, { status: 'Offer' });

    const response = await user.agent.get('/api/dashboard').expect(200);

    expect(response.body.totalApplications).toBe(3);
    expect(response.body.statusBreakdown).toHaveLength(11);

    const counts = Object.fromEntries(
      response.body.statusBreakdown.map((entry: { status: string; count: number }) => [
        entry.status,
        entry.count,
      ]),
    );
    expect(counts.Applied).toBe(2);
    expect(counts.Offer).toBe(1);
    expect(counts.Draft).toBe(0);
  });

  it('returns a dense daily volume series with gaps filled as zero', async () => {
    const user = await createUser();
    await createBid(user, { bidDate: isoDay(0) });
    await createBid(user, { bidDate: isoDay(0) });
    await createBid(user, { bidDate: isoDay(3) });

    const response = await user.agent.get('/api/dashboard?days=7').expect(200);

    expect(response.body.dailyVolume).toHaveLength(7);
    expect(response.body.dailyVolume.at(-1)).toEqual({ date: isoDay(0), count: 2 });
    expect(response.body.dailyVolume.find((d: { date: string }) => d.date === isoDay(3)).count).toBe(
      1,
    );
    expect(response.body.dailyVolume.find((d: { date: string }) => d.date === isoDay(1)).count).toBe(
      0,
    );
  });

  it('covers the requested number of heatmap weeks', async () => {
    const user = await createUser();
    const response = await user.agent.get('/api/dashboard?weeks=12').expect(200);

    expect(response.body.activity.days).toHaveLength(12 * 7);
    expect(response.body.activity.to).toBe(isoDay(0));
  });

  it('lists only future interviews, soonest first', async () => {
    const user = await createUser();

    await createBid(user, {
      company: 'Past',
      status: 'Screening (Round 1)',
      interviews: [{ stage: 'Screening (Round 1)', dateTime: '2020-01-01T09:00:00' }],
    });
    await createBid(user, {
      company: 'Later',
      status: 'Final Interview',
      interviews: [{ stage: 'Final Interview', dateTime: '2099-06-01T09:00:00' }],
    });
    await createBid(user, {
      company: 'Sooner',
      status: 'Interview (Round 2)',
      interviews: [{ stage: 'Interview (Round 2)', dateTime: '2099-01-01T09:00:00' }],
    });

    const response = await user.agent.get('/api/dashboard').expect(200);

    expect(
      response.body.upcomingInterviews.map((item: { company: string }) => item.company),
    ).toEqual(['Sooner', 'Later']);
  });

  it('honours the row limit', async () => {
    const user = await createUser();
    for (const day of ['01', '02', '03']) {
      await createBid(user, {
        status: 'Final Interview',
        interviews: [{ stage: 'Final Interview', dateTime: `2099-01-${day}T09:00:00` }],
      });
    }

    const response = await user.agent.get('/api/dashboard?limit=2').expect(200);
    expect(response.body.upcomingInterviews).toHaveLength(2);
  });

  it('prefers the agreed rate over the rate bid — business rule 4', async () => {
    const user = await createUser();
    await createBid(user, {
      status: 'Started',
      rateType: 'hourly',
      rateAmount: 85,
      commitmentDetails: { startDate: isoDay(10), contractType: '1099', agreedRate: 110 },
    });

    const response = await user.agent.get('/api/dashboard').expect(200);

    expect(response.body.startedContracts).toHaveLength(1);
    expect(response.body.startedContracts[0]).toMatchObject({
      rate: 110,
      rateType: 'hourly',
      startedOn: isoDay(10),
    });
  });

  it('reports the daily goal from settings', async () => {
    // An admin, because the daily goal is theirs to set — see
    // `settings.service.ts`. The dashboard reads it back for anyone.
    const user = await createAdmin();
    await user.agent.put('/api/settings').send({ dailyBidGoal: 42, theme: 'light' }).expect(200);

    const response = await user.agent.get('/api/dashboard').expect(200);
    expect(response.body.dailyGoal).toBe(42);
  });

  it("counts nothing from another user's bids", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    await createBid(owner);

    const response = await stranger.agent.get('/api/dashboard').expect(200);
    expect(response.body.totalApplications).toBe(0);
  });

  it('rejects an out-of-range window', async () => {
    const user = await createUser();
    await user.agent.get('/api/dashboard?weeks=500').expect(400);
  });
});

describe('export and import', () => {
  it('exports the frontend backup shape', async () => {
    const user = await createUser();
    await createBid(user);

    const response = await user.agent.get('/api/data/export').expect(200);

    expect(Object.keys(response.body).sort()).toEqual(['bids', 'profile', 'settings']);
    expect(response.headers['content-disposition']).toContain('remote-ops-backup.json');
  });

  it('round-trips an export back into a second account', async () => {
    // Both are admins because the bundle carries `dailyBidGoal`, which only an
    // admin may set — on either end. A plain account's round trip keeps its own
    // goal, which is the rule working rather than the export losing data.
    const source = await createAdmin();
    await createBid(source, {
      company: 'Acme Corp',
      status: 'Interview (Round 2)',
      interviews: [{ stage: 'Interview (Round 2)', dateTime: '2026-05-01T09:00:00' }],
    });
    await source.agent.put('/api/settings').send({ dailyBidGoal: 55, theme: 'dark' }).expect(200);

    const backup = await source.agent.get('/api/data/export').expect(200);

    const target = await createAdmin();
    const result = await target.agent.post('/api/data/import').send(backup.body).expect(200);

    expect(result.body).toMatchObject({ mode: 'merge', bidsImported: 1, settingsImported: true });

    const bids = await target.agent.get('/api/bids').expect(200);
    expect(bids.body[0]).toMatchObject({
      company: 'Acme Corp',
      status: 'Interview (Round 2)',
      interviews: [{ stage: 'Interview (Round 2)', dateTime: '2026-05-01T09:00:00' }],
    });

    const settings = await target.agent.get('/api/settings').expect(200);
    expect(settings.body.dailyBidGoal).toBe(55);
  });

  it('merges by default and replaces on request', async () => {
    const user = await createUser();
    await createBid(user, { company: 'Existing' });
    const backup = await user.agent.get('/api/data/export').expect(200);

    await user.agent.post('/api/data/import').send(backup.body).expect(200);
    expect((await user.agent.get('/api/bids').expect(200)).body).toHaveLength(2);

    const replaced = await user.agent
      .post('/api/data/import?mode=replace')
      .send(backup.body)
      .expect(200);

    expect(replaced.body.bidsDeleted).toBe(2);
    expect((await user.agent.get('/api/bids').expect(200)).body).toHaveLength(1);
  });

  it('rejects a bundle that violates the interview rule, importing nothing', async () => {
    const user = await createUser();

    const response = await user.agent
      .post('/api/data/import')
      .send({
        bids: [
          {
            company: 'Fine',
            role: 'Dev',
            location: 'Remote',
            bidDate: '2026-01-01',
            status: 'Applied',
          },
          {
            company: 'Broken',
            role: 'Dev',
            location: 'Remote',
            bidDate: '2026-01-02',
            status: 'Final Interview',
          },
        ],
      })
      .expect(422);

    expect(response.body.error.details[0].path).toBe('bids.1.interviews');

    // The valid first bid must not have been written either.
    expect((await user.agent.get('/api/bids').expect(200)).body).toEqual([]);
  });

  it('resets the account without deleting it', async () => {
    const user = await createUser();
    await createBid(user);
    await user.agent.put('/api/settings').send({ dailyBidGoal: 7, theme: 'dark' }).expect(200);

    const response = await user.agent.delete('/api/data').expect(200);
    expect(response.body.bidsDeleted).toBe(1);

    expect((await user.agent.get('/api/bids').expect(200)).body).toEqual([]);
    expect((await user.agent.get('/api/settings').expect(200)).body).toEqual({
      dailyBidGoal: 100,
      theme: 'light',
    });

    // Still signed in.
    await user.agent.get('/api/auth/me').expect(200);
  });
});

describe('service endpoints', () => {
  it('serves an OpenAPI document listing every route', async () => {
    const user = await createUser();
    const response = await user.agent.get('/openapi.json').expect(200);

    expect(response.body.openapi).toBe('3.1.0');
    expect(Object.keys(response.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/auth/login',
        '/api/bids',
        '/api/bids/{id}',
        '/api/dashboard',
        '/api/data/export',
      ]),
    );
  });

  it('404s an unknown route in the standard error envelope', async () => {
    const user = await createUser();
    const response = await user.agent.get('/api/nope').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
