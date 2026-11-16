import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { env } from '../src/env.js';
import { resetDefaultCompanies } from './helpers.js';

/**
 * These are integration tests against a real Postgres — the point is to catch
 * what a mocked Prisma client cannot: the `@@unique([bidId, stage])` constraint,
 * `DATE` round-tripping without a timezone shift, and transaction rollback.
 *
 * `TEST_DATABASE_URL` selects the database (see `src/env.ts`). Every table is
 * truncated before each test, so it must never point at real data.
 */
if (env.NODE_ENV !== 'test') {
  throw new Error(`Tests must run with NODE_ENV=test (got "${env.NODE_ENV}").`);
}

const TABLES = [
  'notifications',
  'interview_rounds',
  'commitments',
  'bids',
  'work_experience',
  'education',
  'profiles',
  'settings',
  'refresh_tokens',
  'users',
  // Deployment-wide rather than user-owned, but a test that saves an API key
  // must not leave it in place for the next one.
  'ai_settings',
];

beforeEach(async () => {
  resetDefaultCompanies();
  // One statement, so foreign keys never see an intermediate state. CASCADE
  // covers any table added later that references these.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
