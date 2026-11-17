import { describe, expect, it } from 'vitest';
import { prisma } from '../src/prisma.js';
import { cleanAvoidList } from '../src/profiles/profile-avoid.service.js';
import { createAdmin, createUser, request } from './helpers.js';

async function standaloneProfile(): Promise<string> {
  const row = await prisma.profile.create({
    data: { firstName: 'Jonathan', lastName: 'Bai' },
    select: { id: true },
  });
  return row.id;
}

describe('cleanAvoidList', () => {
  it('trims, single-spaces and drops empties and repeats in any case', () => {
    expect(cleanAvoidList(['  Manager ', 'manager', '', '  ', 'Sr.   Director', 'QA'])).toEqual([
      'Manager',
      'Sr. Director',
      'QA',
    ]);
  });
});

describe('/api/profiles/:id/avoid', () => {
  it('starts empty, and an admin saves and reads back both lists', async () => {
    const admin = await createAdmin();
    const id = await standaloneProfile();

    const empty = await admin.agent.get(`/api/profiles/${id}/avoid`).expect(200);
    expect(empty.body).toEqual({ avoidRoles: [], avoidCompanies: [] });

    const saved = await admin.agent
      .put(`/api/profiles/${id}/avoid`)
      .send({ avoidRoles: ['Manager', ' intern ', 'MANAGER'], avoidCompanies: ['Amazon'] })
      .expect(200);
    expect(saved.body).toEqual({ avoidRoles: ['Manager', 'intern'], avoidCompanies: ['Amazon'] });

    // A list left out is untouched.
    await admin.agent.put(`/api/profiles/${id}/avoid`).send({ avoidCompanies: [] }).expect(200);
    const read = await admin.agent.get(`/api/profiles/${id}/avoid`).expect(200);
    expect(read.body).toEqual({ avoidRoles: ['Manager', 'intern'], avoidCompanies: [] });
  });

  it('is open to a User the profile is shared with, and hidden from anyone else', async () => {
    const admin = await createAdmin();
    const shared = await createUser();
    const stranger = await createUser();
    const id = await standaloneProfile();
    await admin.agent.put(`/api/admin/profiles/${id}/shares`).send({ userIds: [shared.id] }).expect(200);

    await shared.agent.put(`/api/profiles/${id}/avoid`).send({ avoidRoles: ['QA'] }).expect(200);
    await stranger.agent.get(`/api/profiles/${id}/avoid`).expect(404);
    await stranger.agent.put(`/api/profiles/${id}/avoid`).send({ avoidRoles: ['x'] }).expect(404);
    await request().get(`/api/profiles/${id}/avoid`).expect(401);
  });

  it('refuses an entry over 100 characters', async () => {
    const admin = await createAdmin();
    const id = await standaloneProfile();
    await admin.agent
      .put(`/api/profiles/${id}/avoid`)
      .send({ avoidRoles: ['x'.repeat(101)] })
      .expect(400);
  });
});
