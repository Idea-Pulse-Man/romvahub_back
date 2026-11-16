import { describe, expect, it } from 'vitest';
import { prisma } from '../src/prisma.js';
import { bidPayload, createAdmin, createBid, createUser, request } from './helpers.js';

describe('bid CRUD', () => {
  it('creates a bid and returns the frontend-shaped object', async () => {
    const user = await createUser();

    const bid = await createBid(user, {
      jobUrl: 'https://example.test/jobs/1',
      notes: 'Looks like a good match.',
    });

    expect(bid).toMatchObject({
      company: 'Acme Corp',
      role: 'Senior Frontend Engineer',
      location: 'Remote, TX',
      bidDate: '2026-03-01',
      status: 'Applied',
      jobUrl: 'https://example.test/jobs/1',
    });
    expect(bid.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(bid.createdAt).toMatch(/Z$/);
  });

  it('treats an empty-string optional as absent, the way the form submits it', async () => {
    const user = await createUser();
    // The frontend's EMPTY_FORM initialises jobUrl and jobDescription to ''.
    const bid = await createBid(user, { jobUrl: '', jobDescription: '' });

    expect(bid.jobUrl).toBeUndefined();
    expect(bid.jobDescription).toBeUndefined();
  });

  it('defaults status to Draft when the client omits it', async () => {
    const user = await createUser();
    const payload = bidPayload();
    delete (payload as Record<string, unknown>).status;

    const response = await user.agent.post('/api/bids').send(payload).expect(201);
    expect(response.body.status).toBe('Draft');
  });

  it('rejects a bid with no company', async () => {
    const user = await createUser();
    const response = await user.agent
      .post('/api/bids')
      .send(bidPayload({ company: '' }))
      .expect(400);

    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({ path: 'body.company' }),
    );
  });

  it('lists bids newest bid date first', async () => {
    const user = await createUser();
    await createBid(user, { company: 'Older', bidDate: '2026-01-01' });
    await createBid(user, { company: 'Newer', bidDate: '2026-06-01' });

    const response = await user.agent.get('/api/bids').expect(200);
    expect(response.body.map((bid: { company: string }) => bid.company)).toEqual([
      'Newer',
      'Older',
    ]);
  });

  it('updates only the fields supplied', async () => {
    const user = await createUser();
    const bid = await createBid(user, { notes: 'original' });

    const response = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ company: 'Renamed' })
      .expect(200);

    expect(response.body.company).toBe('Renamed');
    expect(response.body.notes).toBe('original');
    expect(response.body.role).toBe(bid.role);
  });

  it('ignores server-owned fields the edit form echoes back', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    // The frontend's ApplicationForm spreads the whole bid into its update.
    const response = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ ...bid, company: 'Renamed', createdAt: '1999-01-01T00:00:00.000Z' })
      .expect(200);

    expect(response.body.id).toBe(bid.id);
    expect(response.body.createdAt).toBe(bid.createdAt);
    expect(response.body.company).toBe('Renamed');
  });

  it('deletes a bid, for an admin', async () => {
    const admin = await createAdmin();
    const bid = await createBid(admin);

    await admin.agent.delete(`/api/bids/${bid.id}`).expect(204);
    await admin.agent.get(`/api/bids/${bid.id}`).expect(404);
  });

  it('404s on a well-formed id that does not exist', async () => {
    const user = await createUser();
    await user.agent.get('/api/bids/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('400s on an id that is not a uuid', async () => {
    const user = await createUser();
    await user.agent.get('/api/bids/not-a-uuid').expect(400);
  });
});

describe('application numbers', () => {
  it('numbers applications from 1 in the order they are filed, per account', async () => {
    const first = await createUser();
    const second = await createUser();

    const a = await createBid(first);
    const b = await createBid(first);
    const other = await createBid(second);

    expect([a.number, b.number]).toEqual([1, 2]);
    // Another account's applications are numbered on their own.
    expect(other.number).toBe(1);
  });

  it('leaves a gap rather than renumbering when an application is deleted', async () => {
    const admin = await createAdmin();
    await createBid(admin);
    const second = await createBid(admin);
    await createBid(admin);

    await admin.agent.delete(`/api/bids/${second.id}`).expect(204);
    const fourth = await createBid(admin);
    expect(fourth.number).toBe(4);

    const list = await admin.agent.get('/api/bids?sort=number').expect(200);
    expect(list.body.map((bid: { number: number }) => bid.number)).toEqual([1, 3, 4]);
  });

  it('lists in filing order when sorted by number, whatever the bid dates', async () => {
    const user = await createUser();
    await createBid(user, { company: 'Filed first', bidDate: '2026-06-01' });
    await createBid(user, { company: 'Filed second', bidDate: '2026-01-01' });

    const response = await user.agent.get('/api/bids?sort=number&page=1&pageSize=10').expect(200);
    expect(response.body.items.map((bid: { company: string }) => bid.company)).toEqual([
      'Filed first',
      'Filed second',
    ]);
  });
});

describe('the closed statuses', () => {
  it('accepts Expired and Other, and filters by them', async () => {
    const user = await createUser();
    const expired = await createBid(user, { status: 'Expired' });
    const other = await createBid(user);
    await createBid(user);

    expect(expired.status).toBe('Expired');
    const moved = await user.agent.patch(`/api/bids/${other.id}`).send({ status: 'Other' }).expect(200);
    expect(moved.body.status).toBe('Other');

    const filtered = await user.agent.get('/api/bids?status=Other').expect(200);
    expect(filtered.body.map((bid: { id: string }) => bid.id)).toEqual([other.id]);
  });

  it('counts them on the pipeline board', async () => {
    const user = await createUser();
    await createBid(user, { status: 'Expired' });
    await createBid(user, { status: 'Other' });

    const board = await user.agent.get('/api/bids/pipeline').expect(200);
    const totals = Object.fromEntries(
      board.body.stages.map((stage: { status: string; total: number }) => [stage.status, stage.total]),
    );
    expect(totals).toMatchObject({ Expired: 1, Other: 1 });
  });
});

describe('per-user isolation', () => {
  it("hides another user's bid behind a 404, not a 403", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const bid = await createBid(owner);

    // 404 rather than 403: a 403 would confirm the bid exists.
    await stranger.agent.get(`/api/bids/${bid.id}`).expect(404);
    await stranger.agent.patch(`/api/bids/${bid.id}`).send({ company: 'Stolen' }).expect(404);
    await stranger.agent.delete(`/api/bids/${bid.id}`).expect(404);

    const stillThere = await owner.agent.get(`/api/bids/${bid.id}`).expect(200);
    expect(stillThere.body.company).toBe('Acme Corp');
  });

  it("keeps another user's bids out of the list", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    await createBid(owner);

    const response = await stranger.agent.get('/api/bids').expect(200);
    expect(response.body).toEqual([]);
  });

  it("will not let a user bulk-delete another user's bids", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const bid = await createBid(owner);

    const response = await stranger.agent
      .post('/api/bids/bulk/delete')
      .send({ ids: [bid.id] })
      .expect(200);
    expect(response.body).toEqual({ deleted: 0 });

    await owner.agent.get(`/api/bids/${bid.id}`).expect(200);
  });

  it('lets an admin reach every profile, which is the point of the role', async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const bid = await createBid(owner);

    const list = await admin.agent.get('/api/bids').expect(200);
    expect(list.body.map((b: { id: string }) => b.id)).toContain(bid.id);

    const single = await admin.agent.get(`/api/bids/${bid.id}`).expect(200);
    expect(single.body.candidate.userId).toBe(owner.id);
  });

  it('requires authentication', async () => {
    await request().get('/api/bids').expect(401);
    await request().post('/api/bids').send(bidPayload()).expect(401);
  });
});

// ---------------------------------------------------------------------------
// Business rules — README §3.2. These are the reason the backend exists: the
// frontend enforced them, and a client-only rule is a suggestion.
// ---------------------------------------------------------------------------

// Rule 1 used to require a scheduled round to enter an interview stage. The
// Pipeline board's interview steps allow a process to be "TBD", so it is gone.
describe('rule 1 (retired) — an interview stage no longer needs a scheduled date', () => {
  it('creates a bid in an interview stage with no round', async () => {
    const user = await createUser();

    const response = await user.agent
      .post('/api/bids')
      .send(bidPayload({ status: 'Screening (Round 1)' }))
      .expect(201);

    expect(response.body.status).toBe('Screening (Round 1)');
    expect(response.body.interviews).toEqual([]);
  });

  it('keeps a round given for a different stage than the status', async () => {
    const user = await createUser();

    const bid = await createBid(user, {
      status: 'Final Interview',
      interviews: [{ stage: 'Screening (Round 1)', dateTime: '2026-04-01T09:00:00' }],
    });
    expect(bid.interviews).toEqual([{ stage: 'Screening (Round 1)', dateTime: '2026-04-01T09:00:00' }]);
  });

  it('accepts an interview stage that comes with its round', async () => {
    const user = await createUser();

    const bid = await createBid(user, {
      status: 'Screening (Round 1)',
      interviews: [{ stage: 'Screening (Round 1)', dateTime: '2026-04-01T09:00:00' }],
    });

    expect(bid.status).toBe('Screening (Round 1)');
    expect(bid.interviews).toEqual([
      { stage: 'Screening (Round 1)', dateTime: '2026-04-01T09:00:00' },
    ]);
  });

  it('moves an existing bid into an interview stage unscheduled', async () => {
    const user = await createAdmin();
    const bid = await createBid(user);

    await user.agent.patch(`/api/bids/${bid.id}`).send({ status: 'Interview (Round 2)' }).expect(200);

    const moved = await user.agent.get(`/api/bids/${bid.id}`).expect(200);
    expect(moved.body.status).toBe('Interview (Round 2)');
  });

  it('allows re-entering a stage that is already scheduled, without resending the round', async () => {
    const user = await createAdmin();
    const bid = await createBid(user, {
      status: 'Screening (Round 1)',
      interviews: [{ stage: 'Screening (Round 1)', dateTime: '2026-04-01T09:00:00' }],
    });

    await user.agent.patch(`/api/bids/${bid.id}`).send({ status: 'Offer' }).expect(200);

    // The round survived the move away, so moving back needs no new date.
    const back = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ status: 'Screening (Round 1)' })
      .expect(200);

    expect(back.body.status).toBe('Screening (Round 1)');
  });

  it('does not apply to non-interview statuses', async () => {
    const user = await createAdmin();
    const bid = await createBid(user);

    for (const status of ['Offer', 'Background Check Passed', 'Started', 'Failed', 'Completed']) {
      const response = await user.agent.patch(`/api/bids/${bid.id}`).send({ status }).expect(200);
      expect(response.body.status).toBe(status);
    }
  });
});

describe('rule 2 — re-entering a stage overwrites its round rather than duplicating it', () => {
  it('keeps one round per stage when the same stage is scheduled twice', async () => {
    const user = await createAdmin();
    const bid = await createBid(user, {
      status: 'Screening (Round 1)',
      interviews: [{ stage: 'Screening (Round 1)', dateTime: '2026-04-01T09:00:00' }],
    });

    const rescheduled = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({
        status: 'Screening (Round 1)',
        interviews: [{ stage: 'Screening (Round 1)', dateTime: '2026-04-08T14:30:00' }],
      })
      .expect(200);

    expect(rescheduled.body.interviews).toEqual([
      { stage: 'Screening (Round 1)', dateTime: '2026-04-08T14:30:00' },
    ]);

    // Confirmed at the source, not just in the response.
    const rows = await prisma.interviewRound.count({ where: { bidId: bid.id } });
    expect(rows).toBe(1);
  });

  it('collapses a payload that lists the same stage twice, keeping the last', async () => {
    const user = await createUser();

    const bid = await createBid(user, {
      status: 'Final Interview',
      interviews: [
        { stage: 'Final Interview', dateTime: '2026-04-01T09:00:00' },
        { stage: 'Final Interview', dateTime: '2026-04-02T11:00:00' },
      ],
    });

    expect(bid.interviews).toEqual([
      { stage: 'Final Interview', dateTime: '2026-04-02T11:00:00' },
    ]);
  });

  it('keeps separate rounds for separate stages', async () => {
    const user = await createUser();

    const bid = await createBid(user, {
      status: 'Interview (Round 2)',
      interviews: [
        { stage: 'Screening (Round 1)', dateTime: '2026-04-01T09:00:00' },
        { stage: 'Interview (Round 2)', dateTime: '2026-04-08T09:00:00' },
      ],
    });

    expect(bid.interviews).toHaveLength(2);
  });
});

describe('rule 3 — transitions are not order-constrained', () => {
  it('allows a jump straight from Draft to Completed', async () => {
    const user = await createAdmin();
    const bid = await createBid(user, { status: 'Draft' });

    const response = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ status: 'Completed' })
      .expect(200);

    expect(response.body.status).toBe('Completed');
  });

  it('allows moving backwards out of a terminal status', async () => {
    const user = await createAdmin();
    const bid = await createBid(user, { status: 'Failed' });

    const response = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ status: 'Applied' })
      .expect(200);

    expect(response.body.status).toBe('Applied');
  });
});

describe('rule 4 — commitments', () => {
  it('stores commitment details alongside the bid', async () => {
    const user = await createUser();

    const bid = await createBid(user, {
      status: 'Started',
      commitmentDetails: {
        startDate: '2026-03-15',
        contractType: '1099',
        agreedRate: 110,
      },
    });

    expect(bid.commitmentDetails).toEqual({
      startDate: '2026-03-15',
      contractType: '1099',
      agreedRate: 110,
    });
  });

  it('clears the commitment when sent explicitly as null', async () => {
    const user = await createAdmin();
    const bid = await createBid(user, {
      status: 'Started',
      commitmentDetails: { startDate: '2026-03-15', contractType: '1099', agreedRate: 110 },
    });

    const cleared = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ commitmentDetails: null })
      .expect(200);

    expect(cleared.body.commitmentDetails).toBeUndefined();
  });

  it('leaves the commitment alone when the key is omitted', async () => {
    const user = await createAdmin();
    const bid = await createBid(user, {
      status: 'Started',
      commitmentDetails: { startDate: '2026-03-15', contractType: '1099', agreedRate: 110 },
    });

    const response = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ notes: 'still running' })
      .expect(200);

    expect(response.body.commitmentDetails.agreedRate).toBe(110);
  });
});

/**
 * Bulk moves and bulk deletes are administrator actions, so every case here
 * signs in as one. The refusals for a plain account live in "role permissions".
 */
describe('bulk operations', () => {
  it('moves a selection to a non-interview status', async () => {
    const user = await createAdmin();
    const first = await createBid(user);
    const second = await createBid(user);

    const response = await user.agent
      .post('/api/bids/bulk/status')
      .send({ ids: [first.id, second.id], status: 'Failed' })
      .expect(200);

    expect(response.body.updated).toBe(2);

    const list = await user.agent.get('/api/bids').expect(200);
    expect(list.body.every((bid: { status: string }) => bid.status === 'Failed')).toBe(true);
  });

  it('bulk-moves into an interview stage without a date and time', async () => {
    const user = await createAdmin();
    const bid = await createBid(user);

    await user.agent.post('/api/bids/bulk/status').send({ ids: [bid.id], status: 'Final Interview' }).expect(200);

    const moved = await user.agent.get(`/api/bids/${bid.id}`).expect(200);
    expect(moved.body.status).toBe('Final Interview');
    expect(moved.body.interviews).toEqual([]);
  });

  it('applies one shared interview time across the selection', async () => {
    const user = await createAdmin();
    const first = await createBid(user);
    const second = await createBid(user);

    await user.agent
      .post('/api/bids/bulk/status')
      .send({
        ids: [first.id, second.id],
        status: 'Final Interview',
        interviewDateTime: '2026-05-01T13:00:00',
      })
      .expect(200);

    const list = await user.agent.get('/api/bids').expect(200);
    for (const bid of list.body) {
      expect(bid.status).toBe('Final Interview');
      expect(bid.interviews).toEqual([
        { stage: 'Final Interview', dateTime: '2026-05-01T13:00:00' },
      ]);
    }
  });

  it('does not duplicate rounds when the same bulk move is repeated', async () => {
    const user = await createAdmin();
    const bid = await createBid(user);

    for (const dateTime of ['2026-05-01T13:00:00', '2026-05-02T15:00:00']) {
      await user.agent
        .post('/api/bids/bulk/status')
        .send({ ids: [bid.id], status: 'Final Interview', interviewDateTime: dateTime })
        .expect(200);
    }

    expect(await prisma.interviewRound.count({ where: { bidId: bid.id } })).toBe(1);
  });

  it('bulk-deletes the selection', async () => {
    const user = await createAdmin();
    const first = await createBid(user);
    const second = await createBid(user);
    const survivor = await createBid(user, { company: 'Survivor' });

    const response = await user.agent
      .post('/api/bids/bulk/delete')
      .send({ ids: [first.id, second.id] })
      .expect(200);

    expect(response.body.deleted).toBe(2);

    const list = await user.agent.get('/api/bids').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(survivor.id);
  });
});

describe('list filters', () => {
  it('filters by status, date range and search term', async () => {
    const user = await createUser();
    await createBid(user, { company: 'Alpha', bidDate: '2026-01-10', status: 'Applied' });
    await createBid(user, { company: 'Beta', bidDate: '2026-02-10', status: 'Offer' });
    await createBid(user, { company: 'Gamma', bidDate: '2026-03-10', status: 'Applied' });

    const byStatus = await user.agent.get('/api/bids?status=Offer').expect(200);
    expect(byStatus.body.map((bid: { company: string }) => bid.company)).toEqual(['Beta']);

    const byRange = await user.agent.get('/api/bids?from=2026-02-01&to=2026-02-28').expect(200);
    expect(byRange.body.map((bid: { company: string }) => bid.company)).toEqual(['Beta']);

    // Case-insensitive, matching the frontend's toLowerCase() comparison.
    const bySearch = await user.agent.get('/api/bids?search=gam').expect(200);
    expect(bySearch.body.map((bid: { company: string }) => bid.company)).toEqual(['Gamma']);
  });

  /**
   * The application form's duplicate check: after a posting is read, it asks
   * whether anyone in scope has already applied at that company. The whole
   * name, case-insensitively — a substring would report Metabase for Meta.
   */
  it('filters by the whole company name, case-insensitively', async () => {
    const user = await createUser();
    await createBid(user, { company: 'Meta', role: 'Engineer' });
    await createBid(user, { company: 'Metabase', role: 'Engineer' });

    const byCompany = await user.agent.get('/api/bids?company=meta').expect(200);
    expect(byCompany.body.map((bid: { company: string }) => bid.company)).toEqual(['Meta']);

    const none = await user.agent.get('/api/bids?company=Google').expect(200);
    expect(none.body).toEqual([]);
  });

  it('matches one employer however its name was written', async () => {
    // One profile cannot hold two applications at one employer, so the
    // spellings are spread over two candidates and an admin looks at both.
    const first = await createUser();
    const second = await createUser();
    const admin = await createAdmin();
    await createBid(first, { company: 'Acme, Inc.', role: 'Engineer' });
    await createBid(second, { company: 'The ACME Company', role: 'Designer' });
    await createBid(first, { company: "Domino's", role: 'Analyst' });
    await createBid(first, { company: 'Acme Robotics', role: 'Engineer' });

    const acme = await admin.agent.get('/api/bids?company=acme').expect(200);
    expect(acme.body.map((bid: { company: string }) => bid.company).sort()).toEqual(
      ['Acme, Inc.', 'The ACME Company'].sort(),
    );

    const dominos = await first.agent.get('/api/bids?company=Dominos%20LLC').expect(200);
    expect(dominos.body.map((bid: { company: string }) => bid.company)).toEqual(["Domino's"]);
  });

  it("moves the version when the caller's applications change, and only then", async () => {
    const user = await createUser();
    const stranger = await createUser();
    const version = async () => (await user.agent.get('/api/bids/version').expect(200)).body.version as string;

    const empty = await version();
    const bid = await createBid(user, { company: 'Acme' });
    const afterCreate = await version();
    expect(afterCreate).not.toBe(empty);

    // Someone else's application is not a change to this list.
    await createBid(stranger, { company: 'Globex' });
    expect(await version()).toBe(afterCreate);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await user.agent.patch(`/api/bids/${bid.id}`).send({ notes: 'called back' }).expect(200);
    const afterEdit = await version();
    expect(afterEdit).not.toBe(afterCreate);

    await user.agent.delete(`/api/bids/${bid.id}`).expect(204);
    expect(await version()).not.toBe(afterEdit);
  });

  describe('refusing a second application', () => {
    it('refuses the same posting by link, however the link is decorated', async () => {
      const user = await createUser();
      const original = await createBid(user, {
        company: 'Acme',
        role: 'Engineer',
        jobUrl: 'https://boards.example.com/acme/jobs/42',
      });

      const again = await user.agent
        .post('/api/bids')
        .send(bidPayload({ company: 'Globex', jobUrl: 'https://Boards.Example.com/acme/jobs/42/?utm_source=jobright#apply' }))
        .expect(409);
      expect(again.body.error.code).toBe('DUPLICATE_APPLICATION');
      expect(again.body.error.data.reason).toBe('job-url');
      expect(again.body.error.data.matches.map((m: { id: string }) => m.id)).toEqual([original.id]);
    });

    it('refuses another posting at the same employer, however its name is written', async () => {
      const user = await createUser();
      await createBid(user, { company: 'Acme, Inc.', role: 'Engineer' });

      for (const company of ['Acme', 'ACME Corp.', 'The Acme Company']) {
        const response = await user.agent
          .post('/api/bids')
          .send(bidPayload({ company, role: 'Designer' }))
          .expect(409);
        expect(response.body.error.data.reason).toBe('company');
        expect(response.body.error.message).toMatch(/Acme, Inc\./);
      }

      // A different employer whose name merely starts the same is fine.
      await createBid(user, { company: 'Acme Robotics', role: 'Designer' });
    });

    it('lets two candidates apply to the same employer', async () => {
      await createBid(await createUser(), { company: 'Acme' });
      await createBid(await createUser(), { company: 'Acme' });
    });

    it('refuses renaming an application into a duplicate, but not keeping its own company', async () => {
      const user = await createUser();
      await createBid(user, { company: 'Acme' });
      const other = await createBid(user, { company: 'Globex' });

      const renamed = await user.agent.patch(`/api/bids/${other.id}`).send({ company: 'ACME Inc' }).expect(409);
      expect(renamed.body.error.data.reason).toBe('company');

      // Edits that leave the employer alone are untouched by the rule.
      await user.agent.patch(`/api/bids/${other.id}`).send({ company: 'Globex, LLC', notes: 'x' }).expect(200);
    });

    it('lets only one of two simultaneous saves through', async () => {
      const user = await createUser();
      const results = await Promise.all(
        [1, 2, 3].map(() => user.agent.post('/api/bids').send(bidPayload({ company: 'Initech' }))),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });
  });

  it('scopes the company filter to the caller: every profile for an admin, its own for a user', async () => {
    const first = await createUser();
    const second = await createUser();
    const admin = await createAdmin();
    await createBid(first, { company: 'Google', role: 'Engineer' });
    await createBid(second, { company: 'Google', role: 'Designer' });

    const own = await first.agent.get('/api/bids?company=Google').expect(200);
    expect(own.body.map((bid: { candidate: { userId: string } }) => bid.candidate.userId)).toEqual([first.id]);

    const all = await admin.agent.get('/api/bids?company=Google').expect(200);
    expect(all.body.map((bid: { candidate: { userId: string } }) => bid.candidate.userId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it('rejects a malformed date filter', async () => {
    const user = await createUser();
    await user.agent.get('/api/bids?from=03-01-2026').expect(400);
  });
});

// ---------------------------------------------------------------------------

/**
 * Paging. The same route as the list; naming a page is what switches the
 * answer from the array to a `BidPage`, and the screens that still need every
 * row (Dashboard, Calendar, Commitments) go on getting the array.
 */
describe('paging', () => {
  async function sevenBids(user: Awaited<ReturnType<typeof createUser>>) {
    for (let day = 1; day <= 7; day += 1) {
      await createBid(user, { company: `Company ${day}`, bidDate: `2026-01-0${day}` });
    }
  }

  it('answers with the whole array when no page is named', async () => {
    const user = await createUser();
    await sevenBids(user);

    const response = await user.agent.get('/api/bids').expect(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(7);
  });

  it('answers with a page, newest first, when one is named', async () => {
    const user = await createUser();
    await sevenBids(user);

    const first = await user.agent.get('/api/bids?page=1&pageSize=3').expect(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 3, total: 7, totalPages: 3 });
    expect(first.body.items.map((bid: { company: string }) => bid.company)).toEqual([
      'Company 7',
      'Company 6',
      'Company 5',
    ]);

    const last = await user.agent.get('/api/bids?page=3&pageSize=3').expect(200);
    expect(last.body.items.map((bid: { company: string }) => bid.company)).toEqual(['Company 1']);

    // Past the end is an empty page, not an error: a table can land there
    // when the last row on its page is deleted.
    const beyond = await user.agent.get('/api/bids?page=4&pageSize=3').expect(200);
    expect(beyond.body.items).toEqual([]);
    expect(beyond.body.total).toBe(7);
  });

  it('defaults to 25 rows and page 1 when only one of the two is sent', async () => {
    const user = await createUser();
    await createBid(user);

    const byPage = await user.agent.get('/api/bids?page=1').expect(200);
    expect(byPage.body).toMatchObject({ page: 1, pageSize: 25, total: 1, totalPages: 1 });

    const bySize = await user.agent.get('/api/bids?pageSize=10').expect(200);
    expect(bySize.body).toMatchObject({ page: 1, pageSize: 10 });
  });

  it('counts across the filters, not across everything', async () => {
    const user = await createUser();
    await createBid(user, { company: 'Alpha', status: 'Applied' });
    await createBid(user, { company: 'Beta', status: 'Offer' });
    await createBid(user, { company: 'Gamma', status: 'Applied' });

    const response = await user.agent.get('/api/bids?status=Applied&page=1&pageSize=1').expect(200);
    expect(response.body.total).toBe(2);
    expect(response.body.totalPages).toBe(2);
    expect(response.body.items).toHaveLength(1);
  });

  it('reports one empty page for a filter that matches nothing', async () => {
    const user = await createUser();
    const response = await user.agent.get('/api/bids?search=nothing&page=1').expect(200);
    expect(response.body).toMatchObject({ items: [], total: 0, totalPages: 1 });
  });

  it('orders by updatedAt when asked, so a card just moved leads its column', async () => {
    const user = await createUser();
    const older = await createBid(user, { company: 'Older', bidDate: '2026-03-01' });
    await createBid(user, { company: 'Newer', bidDate: '2026-03-02' });

    await user.agent.patch(`/api/bids/${older.id}`).send({ notes: 'touched' }).expect(200);

    const byUpdate = await user.agent.get('/api/bids?sort=updatedAt&page=1').expect(200);
    expect(byUpdate.body.items.map((bid: { company: string }) => bid.company)).toEqual([
      'Older',
      'Newer',
    ]);

    // The default is still the bid date, where the newer application leads.
    const byDate = await user.agent.get('/api/bids?page=1').expect(200);
    expect(byDate.body.items.map((bid: { company: string }) => bid.company)).toEqual([
      'Newer',
      'Older',
    ]);
  });

  it('rejects a page before the first, an empty page, and a page over the cap', async () => {
    const user = await createUser();
    await user.agent.get('/api/bids?page=0').expect(400);
    await user.agent.get('/api/bids?pageSize=0').expect(400);
    await user.agent.get('/api/bids?pageSize=101').expect(400);
    await user.agent.get('/api/bids?page=two').expect(400);
    await user.agent.get('/api/bids?sort=company').expect(400);
  });
});

// ---------------------------------------------------------------------------

/**
 * The Pipeline board's opening state: every stage's count and first page in
 * one request, ordered the way the column's later pages are.
 */
describe('pipeline board', () => {
  it('names every status in funnel order, with its count and first page', async () => {
    const user = await createUser();
    await createBid(user, { company: 'A1', status: 'Applied' });
    await createBid(user, { company: 'A2', status: 'Applied' });
    await createBid(user, { company: 'A3', status: 'Applied' });
    await createBid(user, { company: 'D1', status: 'Draft' });

    const response = await user.agent.get('/api/bids/pipeline?pageSize=2').expect(200);
    expect(response.body.pageSize).toBe(2);
    expect(response.body.stages.map((stage: { status: string }) => stage.status)).toEqual([
      'Draft',
      'Applied',
      'Screening (Round 1)',
      'Interview (Round 2)',
      'Interview (Round 3)',
      'Final Interview',
      'Offer',
      'Background Check Passed',
      'Started',
      'Completed',
      'Failed',
    ]);

    const applied = response.body.stages.find((stage: { status: string }) => stage.status === 'Applied');
    expect(applied.total).toBe(3);
    expect(applied.items).toHaveLength(2);
    // Most recently created last, so most recently updated first.
    expect(applied.items.map((bid: { company: string }) => bid.company)).toEqual(['A3', 'A2']);

    const draft = response.body.stages.find((stage: { status: string }) => stage.status === 'Draft');
    expect(draft).toMatchObject({ total: 1 });
    expect(draft.items).toHaveLength(1);

    const offer = response.body.stages.find((stage: { status: string }) => stage.status === 'Offer');
    expect(offer).toMatchObject({ total: 0, items: [] });
  });

  it("lines page 2 of a column up exactly behind the board's first page", async () => {
    const user = await createUser();
    for (let i = 1; i <= 5; i += 1) {
      await createBid(user, { company: `A${i}`, status: 'Applied' });
    }

    const board = await user.agent.get('/api/bids/pipeline?pageSize=2').expect(200);
    const applied = board.body.stages.find((stage: { status: string }) => stage.status === 'Applied');

    const second = await user.agent
      .get('/api/bids?status=Applied&sort=updatedAt&page=2&pageSize=2')
      .expect(200);
    const third = await user.agent
      .get('/api/bids?status=Applied&sort=updatedAt&page=3&pageSize=2')
      .expect(200);

    const names = (bids: { company: string }[]) => bids.map((bid) => bid.company);
    expect([...names(applied.items), ...names(second.body.items), ...names(third.body.items)]).toEqual([
      'A5',
      'A4',
      'A3',
      'A2',
      'A1',
    ]);
  });

  it("keeps another user's applications off the board", async () => {
    const owner = await createUser();
    const other = await createUser();
    await createBid(owner, { status: 'Applied' });
    await createBid(other, { status: 'Applied' });
    await createBid(other, { status: 'Offer' });

    const response = await owner.agent.get('/api/bids/pipeline').expect(200);
    const totals = Object.fromEntries(
      response.body.stages.map((stage: { status: string; total: number }) => [stage.status, stage.total]),
    );
    expect(totals.Applied).toBe(1);
    expect(totals.Offer).toBe(0);
  });

  it('defaults to ten cards a column and rejects a size over the cap', async () => {
    const user = await createUser();
    const response = await user.agent.get('/api/bids/pipeline').expect(200);
    expect(response.body.pageSize).toBe(10);
    await user.agent.get('/api/bids/pipeline?pageSize=0').expect(400);
    await user.agent.get('/api/bids/pipeline?pageSize=101').expect(400);
  });

  it('is not mistaken for a bid id', async () => {
    const user = await createUser();
    // Were the route declared after `/:id`, "pipeline" would validate as an id
    // and 400 rather than answer.
    await user.agent.get('/api/bids/pipeline').expect(200);
  });
});

// ---------------------------------------------------------------------------

/**
 * Application actions are role-equal; the difference is scope. An admin can
 * reach every profile, while a user can act only on accessible applications.
 */
describe('role permissions', () => {
  it('lets a user change status', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    const response = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ status: 'Offer' })
      .expect(200);
    expect(response.body.status).toBe('Offer');
  });

  it('lets a plain user edit everything else, including echoing the status back', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    // The edit form submits the whole bid, status included. Re-sending the
    // status it already has is not a change, and must not be refused as one.
    const response = await user.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ notes: 'Recruiter replied.', status: 'Applied' })
      .expect(200);

    expect(response.body.notes).toBe('Recruiter replied.');
  });

  it('lets a user delete an accessible application', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    await user.agent.delete(`/api/bids/${bid.id}`).expect(204);
    await user.agent.get(`/api/bids/${bid.id}`).expect(404);
  });

  it('lets a user bulk-move accessible applications', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    await user.agent
      .post('/api/bids/bulk/status')
      .send({ ids: [bid.id], status: 'Failed' })
      .expect(200, { updated: 1 });
  });

  it('lets an admin change a status and delete', async () => {
    const admin = await createAdmin();
    const bid = await createBid(admin);

    const moved = await admin.agent
      .patch(`/api/bids/${bid.id}`)
      .send({ status: 'Offer' })
      .expect(200);
    expect(moved.body.status).toBe('Offer');

    await admin.agent.delete(`/api/bids/${bid.id}`).expect(204);
  });

  it('files an admin-created application under the chosen profile', async () => {
    const admin = await createAdmin();
    const candidate = await createUser();

    const response = await admin.agent
      .post('/api/bids')
      .send(bidPayload({ userId: candidate.id }))
      .expect(201);

    expect(response.body.candidate.userId).toBe(candidate.id);

    // And it lands in that account's own list, which is the whole point.
    const theirs = await candidate.agent.get('/api/bids').expect(200);
    expect(theirs.body.map((b: { id: string }) => b.id)).toContain(response.body.id);
  });

  it('ignores a userId sent by a plain user rather than honouring it', async () => {
    const user = await createUser();
    const victim = await createUser();

    const response = await user.agent
      .post('/api/bids')
      .send(bidPayload({ userId: victim.id }))
      .expect(201);

    // Filed under the sender, not the account they named.
    expect(response.body.candidate.userId).toBe(user.id);

    const victimList = await victim.agent.get('/api/bids').expect(200);
    expect(victimList.body).toEqual([]);
  });

  it('names the candidate on every bid, including a plain user\'s own', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    expect(bid.candidate).toMatchObject({
      userId: user.id,
      firstName: 'Test',
      lastName: 'User',
      displayName: 'Test User',
    });
  });
});
