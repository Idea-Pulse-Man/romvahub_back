import { prisma } from '../prisma.js';
import { UnauthorizedError } from '../http/errors.js';
import type { UserRole } from './auth.schemas.js';
import { enrichLoginContext } from './login-enrichment.js';
import { hashPassword, verifyPassword } from './password.js';
import { createRefreshToken, hashRefreshToken, signAccessToken } from './tokens.js';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
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
  createdAt: Date;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    role: toApiRole(user.role),
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
): Promise<AuthResult> {
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
