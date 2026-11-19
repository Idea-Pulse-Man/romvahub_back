/**
 * The Super Admin: support@romva.space. An admin who also makes and revokes
 * the Profile tokens the Chrome extension and the Resume agent sign in with,
 * and who signs in with an authenticator app as well as the password.
 *
 *   yarn super-admin                         make support@romva.space the Super Admin
 *   yarn super-admin '<password>'            … creating it, or resetting its password
 *   yarn super-admin --reset-authenticator   a lost phone: the authenticator is set up
 *                                            again (a new QR code) on the next sign-in
 *
 *   DATABASE_URL='postgresql://…' yarn super-admin …   against the database you mean
 *
 * Other admins are left as they are. Nothing is deleted.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/auth/password.js';

const SUPER_ADMIN_EMAIL = 'support@romva.space';
const MIN_PASSWORD_LENGTH = 12;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const resetAuthenticator = args.includes('--reset-authenticator');
const password = args.find((a) => !a.startsWith('--'));

if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
  fail(`That password is ${password.length} characters; the minimum is ${MIN_PASSWORD_LENGTH}.`);
}

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) fail('DATABASE_URL is not set.');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main(): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { email: SUPER_ADMIN_EMAIL } });
  if (!existing && !password) {
    fail(`No account exists for ${SUPER_ADMIN_EMAIL}, so one has to be created — pass a password:\n\n  yarn super-admin '<password>'`);
  }
  const passwordHash = password ? await hashPassword(password) : undefined;
  const authenticator = resetAuthenticator ? { totpSecret: null, totpEnabledAt: null, totpLastStep: null } : {};

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { role: 'ADMIN', superAdmin: true, status: 'ACTIVE', ...(passwordHash ? { passwordHash } : {}), ...authenticator },
      })
    : await prisma.user.create({
        data: { email: SUPER_ADMIN_EMAIL, role: 'ADMIN', superAdmin: true, passwordHash: passwordHash as string },
      });

  // Only one Super Admin.
  await prisma.user.updateMany({ where: { id: { not: user.id }, superAdmin: true }, data: { superAdmin: false } });

  await prisma.profile.upsert({ where: { userId: user.id }, create: { userId: user.id, email: SUPER_ADMIN_EMAIL }, update: {} });
  await prisma.settings.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  if (resetAuthenticator) await prisma.loginChallenge.deleteMany({ where: { userId: user.id } });

  console.log(`${existing ? 'Made' : 'Created'} ${SUPER_ADMIN_EMAIL} the Super Admin${password ? (existing ? ' (password reset)' : '') : ''}.`);
  if (resetAuthenticator || !user.totpEnabledAt) {
    console.log('On its next sign-in it sets up an authenticator app (a QR code to scan).');
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
