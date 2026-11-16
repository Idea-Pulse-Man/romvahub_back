/**
 * Creates or promotes the sole administrator, safely, against any database —
 * production included.
 *
 *   yarn admin <email> [password]
 *   DATABASE_URL='postgresql://…' yarn admin you@example.com 'a-long-password'
 *
 * This exists because `yarn db:seed` cannot be the answer for a deployed
 * environment. The seed refuses to run with `NODE_ENV=production`, and rightly
 * so: it *replaces* the demo account's bids, which is the correct behaviour for
 * a development database and unacceptable anywhere real. Vercel's build runs
 * `prisma migrate deploy` and nothing else, so a deployed database has the
 * schema and no seed data at all — and since there is no public registration,
 * a fresh deployment has no way to produce its first admin without this script.
 *
 * This script touches the target user row (and demotes every other admin to
 * `user`, so the deployment stays at exactly one admin). It never deletes
 * anything and never looks at bids.
 *
 * Idempotent: run it against an account that already exists and it is promoted
 * in place, keeping its bids, profile and settings. Supply a password and it is
 * reset too; leave it out and the existing one stands.
 *
 * `DATABASE_URL` is read straight from the environment rather than through
 * `src/env.ts`, so creating an admin does not require the JWT secrets and
 * cookie settings that only a running server needs.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/auth/password.js';

/** Minimum password length — matches admin user creation. */
const MIN_PASSWORD_LENGTH = 12;

const USAGE = `
Usage: yarn admin <email> [password]

  <email>     The account to create or promote. Case-insensitive.
  [password]  Required when creating; optional when promoting, where supplying
              one also resets the password. At least ${MIN_PASSWORD_LENGTH} characters.

Point it at the database you mean:

  DATABASE_URL='postgresql://…' yarn admin you@example.com 'a-long-password'
`.trim();

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const [email, password] = process.argv.slice(2);

if (!email) fail(`No email given.\n\n${USAGE}`);
if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
  fail(`That password is ${password.length} characters; the minimum is ${MIN_PASSWORD_LENGTH}.`);
}

// `DIRECT_URL` first: where it is set it is the unpooled connection, and a
// one-off script has no reason to go through a transaction-mode pooler.
const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) fail(`DATABASE_URL is not set.\n\n${USAGE}`);

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main(): Promise<void> {
  const normalizedEmail = (email as string).trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (!existing && !password) {
    fail(
      `No account exists for ${normalizedEmail}, so one has to be created — ` +
        `pass a password:\n\n  yarn admin ${normalizedEmail} '<password>'`,
    );
  }

  const passwordHash = password ? await hashPassword(password) : undefined;

  // Branched rather than upserted: `passwordHash` is required on create and
  // optional on promote, and Prisma validates an upsert's `create` payload even
  // when the `update` branch is the one that runs — so a promotion with no new
  // password fails the shape check before it ever reaches the database.
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { role: 'ADMIN', ...(passwordHash ? { passwordHash } : {}) },
      })
    : await prisma.user.create({
        data: { email: normalizedEmail, role: 'ADMIN', passwordHash: passwordHash as string },
      });

  // Sole-admin invariant: every other admin becomes a plain user.
  await prisma.user.updateMany({
    where: { email: { not: normalizedEmail }, role: 'ADMIN' },
    data: { role: 'USER' },
  });

  // A user registered through the API always has both of these, but an account
  // created by an earlier version of this script — or by hand — might not, and
  // the app expects them to exist.
  await prisma.profile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, email: normalizedEmail },
    update: {},
  });
  await prisma.settings.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {},
  });

  const what = existing ? 'Promoted' : 'Created';
  const passwordNote = password
    ? existing
      ? ' (password reset)'
      : ''
    : ' (existing password kept)';

  console.log(`${what} ${normalizedEmail} as the sole admin${passwordNote}.`);
  if (existing && existing.role === 'ADMIN') {
    console.log('It was already an admin — other admins (if any) were demoted to user.');
  } else {
    console.log('Any other admin accounts were demoted to user.');
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
