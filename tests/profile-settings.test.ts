import { describe, expect, it } from 'vitest';
import { createAdmin, createUser, request } from './helpers.js';

describe('GET /api/profile', () => {
  it('returns a seeded profile for a new account rather than 404ing', async () => {
    const user = await createUser();
    const response = await user.agent.get('/api/profile').expect(200);

    // Registration seeds the profile — with the name it collected — so the
    // frontend's `useProfile()` query never has to cope with a missing one.
    expect(response.body).toMatchObject({
      firstName: 'Test',
      lastName: 'User',
      workExperience: [],
      education: [],
    });
    expect(response.body.email).toBe(user.email);
    // Read-only and absent until a photo is uploaded.
    expect(response.body.photoUrl).toBeUndefined();
  });

  it('requires authentication', async () => {
    await request().get('/api/profile').expect(401);
  });
});

describe('PUT /api/profile', () => {
  const profile = {
    firstName: 'Jordan',
    lastName: 'Rivera',
    dateOfBirth: '1994-06-12',
    location: 'Austin, TX',
    email: 'jordan.rivera@example.com',
    phone: '(512) 555-0142',
    workExperience: [
      {
        id: 'e2ef3a1c-1111-4111-8111-111111111111',
        company: 'TechFlow Solutions',
        location: 'Remote, US',
        startDate: '2021-03',
        endDate: null,
      },
      {
        id: 'e2ef3a1c-2222-4222-8222-222222222222',
        company: 'Innovate Digital',
        location: 'Austin, TX',
        startDate: '2018-06',
        endDate: '2021-02',
      },
    ],
    education: [
      {
        id: 'e2ef3a1c-3333-4333-8333-333333333333',
        degree: 'Bachelor of Science',
        major: 'Computer Science',
        university: 'University of Texas at Austin',
        location: 'Austin, TX',
        startDate: '2014-08',
        endDate: '2018-12',
      },
    ],
  };

  it('saves and reads back the whole profile', async () => {
    const user = await createUser();
    await user.agent.put('/api/profile').send(profile).expect(200);

    const response = await user.agent.get('/api/profile').expect(200);
    expect(response.body).toEqual(profile);
  });

  it('truncates a full date to its month, so older exports still import', async () => {
    const user = await createUser();

    const response = await user.agent
      .put('/api/profile')
      .send({
        ...profile,
        workExperience: [
          { company: 'TechFlow', location: 'Remote', startDate: '2021-03-17', endDate: null },
        ],
        education: [
          {
            degree: 'BS',
            major: 'CS',
            university: 'UT',
            location: 'Austin, TX',
            startDate: '2014-08-20',
            endDate: '2018-12-15',
          },
        ],
      })
      .expect(200);

    expect(response.body.workExperience[0].startDate).toBe('2021-03');
    expect(response.body.education[0].startDate).toBe('2014-08');
    expect(response.body.education[0].endDate).toBe('2018-12');
  });

  it('rejects a month that is not a month', async () => {
    const user = await createUser();

    await user.agent
      .put('/api/profile')
      .send({
        ...profile,
        workExperience: [
          { company: 'TechFlow', location: 'Remote', startDate: '2021', endDate: null },
        ],
      })
      .expect(400);
  });

  it('keeps the order of work history and education', async () => {
    const user = await createUser();
    await user.agent.put('/api/profile').send(profile).expect(200);

    const reordered = {
      ...profile,
      workExperience: [...profile.workExperience].reverse(),
    };
    await user.agent.put('/api/profile').send(reordered).expect(200);

    const response = await user.agent.get('/api/profile').expect(200);
    expect(response.body.workExperience.map((entry: { company: string }) => entry.company)).toEqual(
      ['Innovate Digital', 'TechFlow Solutions'],
    );
  });

  it('honours client-generated uuids so React keys stay stable', async () => {
    const user = await createUser();
    const response = await user.agent.put('/api/profile').send(profile).expect(200);

    expect(response.body.workExperience[0].id).toBe(profile.workExperience[0]!.id);
  });

  it('assigns a server id when the client id is not a uuid', async () => {
    const user = await createUser();

    // The frontend's seed profile uses ids like "1" and "2".
    const response = await user.agent
      .put('/api/profile')
      .send({
        ...profile,
        education: [{ ...profile.education[0], id: '1' }],
      })
      .expect(200);

    expect(response.body.education[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is a replace, not a merge — removed rows stay removed', async () => {
    const user = await createUser();
    await user.agent.put('/api/profile').send(profile).expect(200);

    await user.agent
      .put('/api/profile')
      .send({ ...profile, workExperience: [], education: [] })
      .expect(200);

    const response = await user.agent.get('/api/profile').expect(200);
    expect(response.body.workExperience).toEqual([]);
    expect(response.body.education).toEqual([]);
  });

  it('accepts blank rows, which the form creates before they are filled in', async () => {
    const user = await createUser();

    const response = await user.agent
      .put('/api/profile')
      .send({
        ...profile,
        dateOfBirth: '',
        workExperience: [{ company: '', location: '', startDate: '', endDate: null }],
      })
      .expect(200);

    expect(response.body.dateOfBirth).toBe('');
    expect(response.body.workExperience[0].startDate).toBe('');
    expect(response.body.workExperience[0].endDate).toBeNull();
  });

  it('keeps profiles separate between accounts', async () => {
    const first = await createUser();
    const second = await createUser();

    await first.agent.put('/api/profile').send(profile).expect(200);

    const response = await second.agent.get('/api/profile').expect(200);
    // Their own registration name, not the one the first account just saved.
    expect(response.body.firstName).toBe('Test');
    expect(response.body.location).toBe('');
  });
});

describe('settings', () => {
  it('starts at the documented defaults', async () => {
    const user = await createUser();
    const response = await user.agent.get('/api/settings').expect(200);
    expect(response.body).toEqual({ dailyBidGoal: 100, theme: 'light' });
  });

  it('saves and reads back, for an admin', async () => {
    const admin = await createAdmin();

    await admin.agent.put('/api/settings').send({ dailyBidGoal: 40, theme: 'dark' }).expect(200);

    const response = await admin.agent.get('/api/settings').expect(200);
    expect(response.body).toEqual({ dailyBidGoal: 40, theme: 'dark' });
  });

  it('keeps the stored goal when a plain user tries to change it', async () => {
    const user = await createUser();

    // The daily goal is the deployment's target, so a non-admin's save keeps
    // whatever is stored — and their theme still saves, because refusing the
    // whole request would break a toggle that submits the entire object.
    const response = await user.agent
      .put('/api/settings')
      .send({ dailyBidGoal: 7, theme: 'dark' })
      .expect(200);

    expect(response.body).toEqual({ dailyBidGoal: 100, theme: 'dark' });
  });

  it('rejects a non-integer goal and an unknown theme', async () => {
    const user = await createUser();

    await user.agent.put('/api/settings').send({ dailyBidGoal: 4.5, theme: 'dark' }).expect(400);
    await user.agent.put('/api/settings').send({ dailyBidGoal: 40, theme: 'sepia' }).expect(400);
  });

  it('keeps settings separate between accounts', async () => {
    const first = await createUser();
    const second = await createUser();

    await first.agent.put('/api/settings').send({ dailyBidGoal: 7, theme: 'dark' }).expect(200);

    const response = await second.agent.get('/api/settings').expect(200);
    expect(response.body.dailyBidGoal).toBe(100);
  });
});
