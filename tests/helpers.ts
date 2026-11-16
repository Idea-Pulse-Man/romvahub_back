import supertest from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../src/app.js';
import { prisma } from '../src/prisma.js';
import { hashPassword } from '../src/auth/password.js';
import type { Bid } from '../src/domain/types.js';

const app = createApp();

export function request() {
  return supertest(app);
}

/** A cookie-bearing client, for a test that drives login itself. */
export function agent(): TestAgent {
  return supertest.agent(app);
}

export interface TestUser {
  email: string;
  password: string;
  id: string;
  /** A supertest agent that persists the auth cookies across requests. */
  agent: TestAgent;
}

let counter = 0;

/**
 * Inserts a plain User (no public registration) and returns a cookie-bearing
 * agent signed in as that account. Each call gets a unique email so a test can
 * create two users and assert that neither can see the other's data.
 */
export async function createUser(): Promise<TestUser> {
  counter += 1;
  const email = `user-${counter}-${process.pid}@example.test`;
  const password = 'correct-horse-battery-staple';

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      role: 'USER',
      profile: { create: { email, firstName: 'Test', lastName: 'User' } },
      settings: { create: {} },
    },
    select: { id: true },
  });

  const session = supertest.agent(app);
  await session.post('/api/auth/login').send({ email, password }).expect(200);

  return { email, password, id: user.id, agent: session };
}

/**
 * An administrator, with a session that knows it.
 *
 * The role rides in the access token, so promoting the row is only half of it:
 * signing in again is what makes the session admin. Other admins are demoted so
 * the sole-admin invariant holds inside the suite as well as in production.
 */
export async function createAdmin(): Promise<TestUser> {
  const user = await createUser();

  await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
  await prisma.user.updateMany({
    where: { id: { not: user.id }, role: 'ADMIN' },
    data: { role: 'USER' },
  });
  await user.agent
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password })
    .expect(200);

  return user;
}

const BASE_BID = {
  company: 'Acme Corp',
  role: 'Senior Frontend Engineer',
  location: 'Remote, TX',
  bidDate: '2026-03-01',
  status: 'Applied',
};

export function bidPayload(overrides: Record<string, unknown> = {}) {
  return { ...BASE_BID, ...overrides };
}

/**
 * romva.space refuses a second application at the same company for one profile,
 * so applications made without naming a company get distinct ones: the first in
 * a test is the plain "Acme Corp", the next "Acme Corp 2", and so on. Reset
 * before every test by `setup.ts`.
 */
let defaultCompanies = 0;
export function resetDefaultCompanies(): void {
  defaultCompanies = 0;
}

export async function createBid(
  user: TestUser,
  overrides: Record<string, unknown> = {},
): Promise<Bid> {
  const company =
    'company' in overrides
      ? overrides.company
      : (defaultCompanies += 1) === 1
        ? BASE_BID.company
        : `${BASE_BID.company} ${defaultCompanies}`;
  const response = await user.agent
    .post('/api/bids')
    .send(bidPayload({ ...overrides, company }))
    .expect(201);
  return response.body as Bid;
}
