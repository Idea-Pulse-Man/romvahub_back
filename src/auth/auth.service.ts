import { prisma } from '../prisma.js';
import { UnauthorizedError } from '../http/errors.js';
import type { UserRole } from './auth.schemas.js';
import { enrichLoginContext } from './login-enrichment.js';
import { hashPassword, verifyPassword } from './password.js';
import { createRefreshToken, hashRefreshToken, signAccessToken } from './tokens.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp.js';
import { decryptSecret, encryptSecret } from '../crypto/secret-box.js';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  /** The Super Admin: also makes and revokes Profile tokens (the Tokens page). */
  superAdmin: boolean;
  createdAt: string;
}

/**
 * Prisma's generated enum members are SCREAMING_CASE; the wire uses the mapped
 * lowercase values, the same split `src/domain/status.ts` handles for statuses.
 */
function toApiRole(role: 'USER' | 'ADMIN'): UserRole {
  return role === 'ADMIN' ? 'admin' : 'user';
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends IssuedTokens {
  user: AuthUser;
}

function toAuthUser(user: {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN';
  superAdmin: boolean;
  createdAt: Date;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    role: toApiRole(user.role),
    superAdmin: user.superAdmin,
    createdAt: user.createdAt.toISOString(),
  };
}

async function issueTokens(user: {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN';
}): Promise<IssuedTokens> {
  const { token, tokenHash, expiresAt } = createRefreshToken();
  await prisma.refreshToken.create({ data: { userId: user.id, tokenHash, expiresAt } });

  return {
    // The role rides in the access token so that authorising a request costs no
    // query. It is 15 minutes stale at worst, and a rotation reads the user row
    // again — which is the right trade for a flag that changes by hand.
    accessToken: signAccessToken({ sub: user.id, email: user.email, role: toApiRole(user.role) }),
    refreshToken: token,
  };
}

export interface LoginContext {
  /** Express `req.ip` (honours `trust proxy` when set). */
  ip?: string | null;
  /** Raw `User-Agent` header. */
  userAgent?: string | null;
  /** `Accept-Language` header. */
  acceptLanguage?: string | null;
}

/**
 * Signs in an existing platform User. Accounts are created by an administrator
 * (`POST /api/admin/users`) or by `yarn admin` for the sole Admin — there is
 * no public registration. Suspended accounts cannot sign in.
 *
 * A successful login appends a detailed `LoginHistory` row (IP, location,
 * browser / OS) for admin review. Token refresh does not.
 */
export async function login(
  email: string,
  password: string,
  context: LoginContext = {},
): Promise<AuthResult | MfaChallenge> {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  // Hash even when the user does not exist, so that response time does not
  // reveal which emails are registered.
  const digest = user?.passwordHash ?? (await hashPassword('placeholder-for-timing-parity'));
  const ok = await verifyPassword(digest, password);

  if (!user || !ok) throw new UnauthorizedError('Incorrect email or password.');

  if (user.status === 'SUSPENDED') {
    throw new UnauthorizedError(
      'This account has been suspended. Contact an administrator.',
    );
  }

  // The Super Admin signs in with an authenticator app too: no session until
  // its code is given (POST /api/auth/login/verify). The first time, the app is
  // set up from a new secret shown as a QR code.
  if (user.superAdmin) return startMfa(user);

  return completeLogin(user, context);
}

/** What the sign-in page needs to ask for the authenticator code. */
export interface MfaChallenge {
  mfa: {
    challengeId: string;
    /** The first sign-in: the app is set up from `secret` / `otpauthUrl` (the QR code). */
    setup: boolean;
    email: string;
    secret?: string;
    otpauthUrl?: string;
  };
}

const MFA_TTL_MS = 10 * 60_000;
const MFA_MAX_ATTEMPTS = 5;

async function startMfa(user: { id: string; email: string; totpEnabledAt: Date | null; totpSecret: string | null }): Promise<MfaChallenge> {
  const setup = !user.totpEnabledAt || !decryptSecret(user.totpSecret);
  const secret = setup ? newTotpSecret() : undefined;
  const challenge = await prisma.loginChallenge.create({
    data: {
      userId: user.id,
      setup,
      totpSecret: secret ? encryptSecret(secret) : null,
      expiresAt: new Date(Date.now() + MFA_TTL_MS),
    },
  });
  return {
    mfa: {
      challengeId: challenge.id,
      setup,
      email: user.email,
      ...(secret ? { secret, otpauthUrl: otpauthUrl(secret, user.email) } : {}),
    },
  };
}

/** The authenticator code for a sign-in started by `login`: right, and the session is issued. */
export async function verifyMfa(challengeId: string, code: string, context: LoginContext = {}): Promise<AuthResult> {
  const challenge = await prisma.loginChallenge.findUnique({ where: { id: challengeId }, include: { user: true } });
  const expired = 'This sign-in has expired. Enter your email and password again.';
  if (!challenge || challenge.usedAt || challenge.expiresAt <= new Date()) throw new UnauthorizedError(expired);
  if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
    throw new UnauthorizedError('Too many wrong codes. Enter your email and password again.');
  }
  const user = challenge.user;
  if (user.status === 'SUSPENDED') {
    throw new UnauthorizedError('This account has been suspended. Contact an administrator.');
  }

  const secret = decryptSecret(challenge.setup ? challenge.totpSecret : user.totpSecret);
  if (!secret) throw new UnauthorizedError(expired);
  const step = verifyTotp(secret, code, challenge.setup ? null : user.totpLastStep);
  if (step === null) {
    await prisma.loginChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    const left = MFA_MAX_ATTEMPTS - challenge.attempts - 1;
    throw new UnauthorizedError(
      left > 0 ? `That code is not right. ${left} tr${left === 1 ? 'y' : 'ies'} left.` : 'Too many wrong codes. Enter your email and password again.',
    );
  }

  // Used once, whatever happens next.
  const { count } = await prisma.loginChallenge.updateMany({
    where: { id: challenge.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (count === 0) throw new UnauthorizedError(expired);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      totpLastStep: step,
      ...(challenge.setup ? { totpSecret: challenge.totpSecret, totpEnabledAt: new Date() } : {}),
    },
  });
  // Old challenges of this account are of no further use.
  await prisma.loginChallenge.deleteMany({ where: { userId: user.id, OR: [{ usedAt: { not: null } }, { expiresAt: { lte: new Date() } }] } });

  return completeLogin(user, context);
}

/** A sign-in that passed every check: recorded, and its session issued. */
async function completeLogin(
  user: { id: string; email: string; role: 'USER' | 'ADMIN'; superAdmin: boolean; createdAt: Date },
  context: LoginContext,
): Promise<AuthResult> {
  const details = await enrichLoginContext(context);
  await prisma.loginHistory.create({
    data: {
      userId: user.id,
      ip: details.ip,
      userAgent: details.userAgent,
      acceptLanguage: details.acceptLanguage,
      country: details.country,
      countryCode: details.countryCode,
      region: details.region,
      city: details.city,
      latitude: details.latitude,
      longitude: details.longitude,
      timezone: details.timezone,
      isp: details.isp,
      org: details.org,
      locationLabel: details.locationLabel,
      browser: details.browser,
      os: details.os,
      deviceType: details.deviceType,
    },
  });

  return { user: toAuthUser(user), ...(await issueTokens(user)) };
}

/**
 * Rotates a refresh token: the presented token is revoked and a fresh one
 * issued. Presenting an already-revoked token means it was captured and
 * replayed, so every token in that user's family is revoked and the session
 * ends.
 */
export async function refresh(presentedToken: string): Promise<AuthResult> {
  const tokenHash = hashRefreshToken(presentedToken);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored) throw new UnauthorizedError('Invalid refresh token.');

  if (stored.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new UnauthorizedError('Refresh token has already been used. Please sign in again.');
  }

  if (stored.expiresAt <= new Date()) {
    throw new UnauthorizedError('Refresh token expired. Please sign in again.');
  }

  if (stored.user.status === 'SUSPENDED') {
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new UnauthorizedError(
      'This account has been suspended. Contact an administrator.',
    );
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  return { user: toAuthUser(stored.user), ...(await issueTokens(stored.user)) };
}

/** Revokes the presented token. Logging out twice is not an error. */
export async function logout(presentedToken: string | undefined): Promise<void> {
  if (!presentedToken) return;

  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(presentedToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getUser(userId: string): Promise<AuthUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UnauthorizedError('Account no longer exists.');
  return toAuthUser(user);
}
