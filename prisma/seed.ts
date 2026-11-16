/**
 * Seeds one demo account whose data mirrors what the frontend generates into
 * `localStorage` on first run, so the app looks the same against a fresh
 * database as it did browser-only.
 *
 *   yarn db:seed
 *
 * Idempotent: re-running replaces the demo account's bids rather than
 * duplicating them. It refuses to run with NODE_ENV=production.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/auth/password.js';
import { parseDateOnly, parseNaiveDateTime } from '../src/domain/dates.js';
import { toDbStatus } from '../src/domain/status.js';
import { env } from '../src/env.js';
import type { BidStatus } from '../src/domain/types.js';

const DEMO_EMAIL = 'demo@remoteops.test';
const DEMO_PASSWORD = 'demo-password-1234';

/**
 * The sole administrator. Roles are promoted by hand (README §6.6) and seeding
 * is the one place that hand is already in the database, so this is where the
 * first admin comes from. Unlike the demo account it gets no bids — it is an
 * account to sign in with, not a populated example.
 */
const ADMIN_EMAIL = 'monster@admin.com';
const ADMIN_PASSWORD = 'monstermonster!@#QWE123qwe';

const LOCATIONS = ['Remote', 'Remote, NY', 'Remote, CA', 'Remote, TX'];
const ROLES = [
  'Senior Frontend Engineer',
  'Full Stack Developer',
  'React Developer',
  'Software Engineer',
  'Frontend Architect',
];

/**
 * A fixed rotation rather than `Math.random()`, so two seeded databases are
 * comparable and a failing test is reproducible.
 */
const STATUS_CYCLE: BidStatus[] = [
  'Applied',
  'Applied',
  'Applied',
  'Screening (Round 1)',
  'Applied',
  'Interview (Round 2)',
  'Draft',
  'Screening (Round 1)',
  'Interview (Round 3)',
  'Applied',
  'Final Interview',
  'Offer',
  'Applied',
  'Background Check Passed',
  'Failed',
];

function isoDay(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

/** Zero-padded, because `T9:00:00` is not a valid datetime. */
function hour(value: number): string {
  return String(value).padStart(2, '0');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // Sample data only — never an admin. The sole admin is upserted below.
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: { passwordHash, role: 'USER' },
    create: {
      email: DEMO_EMAIL,
      passwordHash,
      role: 'USER',
      settings: { create: { dailyBidGoal: 100, theme: 'LIGHT' } },
      profile: {
        create: {
          firstName: 'Jordan',
          lastName: 'Rivera',
          dateOfBirth: parseDateOnly('1994-06-12'),
          location: 'Austin, TX',
          email: 'jordan.rivera@example.com',
          phone: '(512) 555-0142',
          workExperience: {
            create: [
              {
                company: 'TechFlow Solutions',
                title: 'Senior Software Engineer',
                location: 'Remote, US',
                startDate: '2021-03',
                endDate: null,
                position: 0,
              },
              {
                company: 'Innovate Digital',
                title: 'Software Engineer',
                location: 'Austin, TX',
                startDate: '2018-06',
                endDate: '2021-02',
                position: 1,
              },
            ],
          },
          education: {
            create: [
              {
                degree: 'Bachelor of Science',
                major: 'Computer Science',
                university: 'University of Texas at Austin',
                location: 'Austin, TX',
                startDate: '2014-08',
                endDate: '2018-12',
                position: 0,
              },
            ],
          },
        },
      },
    },
  });

  // Idempotence: clear this account's bids before re-seeding them.
  const { count: cleared } = await prisma.bid.deleteMany({ where: { userId: user.id } });

  for (let i = 0; i < 45; i += 1) {
    const status = STATUS_CYCLE[i % STATUS_CYCLE.length] as BidStatus;
    const bidDate = isoDay(i % 14);

    // Business rule 1 applies to seed data too: an interview stage needs a round.
    const interviews =
      status === 'Screening (Round 1)' ||
      status === 'Interview (Round 2)' ||
      status === 'Interview (Round 3)' ||
      status === 'Final Interview'
        ? [
            {
              stage: toDbStatus(status),
              // Spread across the coming fortnight so the Calendar and the
              // Dashboard's "Upcoming Schedules" both have something to show.
              dateTime: parseNaiveDateTime(
                `${isoDay(-((i % 14) + 1))}T${hour(9 + (i % 8))}:00:00`,
              ),
            },
          ]
        : [];

    await prisma.bid.create({
      data: {
        userId: user.id,
        company: `Company ${String.fromCharCode(65 + (i % 26))}${i}`,
        role: ROLES[i % ROLES.length] as string,
        location: LOCATIONS[i % LOCATIONS.length] as string,
        rateType: 'HOURLY',
        rateAmount: 85 + (i % 30),
        bidDate: parseDateOnly(bidDate),
        status: toDbStatus(status),
        notes: i % 2 === 0 ? 'Looks like a good match.' : null,
        resumeVersion: 'v2-frontend-focused',
        interviews: { create: interviews },
      },
    });
  }

  await prisma.bid.create({
    data: {
      userId: user.id,
      company: 'Acme Corp',
      role: 'Lead React Developer',
      location: 'Remote',
      rateType: 'HOURLY',
      rateAmount: 110,
      bidDate: parseDateOnly(isoDay(30)),
      status: toDbStatus('Started'),
      commitment: {
        create: {
          startDate: parseDateOnly(isoDay(10)),
          contractType: '1099',
          agreedRate: 110,
        },
      },
    },
  });

  // Upserted the same way the demo account is, so re-seeding resets the
  // password and re-asserts the role rather than failing on the unique email.
  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { passwordHash: await hashPassword(ADMIN_PASSWORD), role: 'ADMIN' },
    create: {
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      settings: { create: {} },
      profile: { create: { email: ADMIN_EMAIL } },
    },
  });

  // Ensure re-seeding cannot leave extra admins behind.
  await prisma.user.updateMany({
    where: { email: { not: ADMIN_EMAIL }, role: 'ADMIN' },
    data: { role: 'USER' },
  });

  console.log(
    `Seeded ${DEMO_EMAIL} (password: ${DEMO_PASSWORD}, role: user) with 46 bids` +
      (cleared > 0 ? ` — replaced ${cleared} existing.` : '.'),
  );
  console.log(`Seeded ${ADMIN_EMAIL} (role: admin) as the sole administrator.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
