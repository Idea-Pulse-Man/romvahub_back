/**
 * User management, for an administrator.
 *
 * A User is a platform login (Admin or User). Profiles — candidate identities
 * for US remote applications — are a separate concept; this module still
 * creates an empty legacy Resume stub so existing Resume routes keep working
 * until Profiles are remodelled.
 *
 * Rules:
 * - Accounts are created here (or via `yarn admin` for the sole Admin). There
 *   is no public sign-up.
 * - This API always creates role `user`. There is exactly one Admin.
 * - An admin cannot delete their own account.
 */
import { prisma } from '../prisma.js';
import { hashPassword } from '../auth/password.js';
import type { UserRole } from '../auth/auth.schemas.js';
import { formatDateOnly } from '../domain/dates.js';
import { BadRequestError, ConflictError, NotFoundError } from '../http/errors.js';
import { signPhotoUrl } from '../storage/s3.client.js';
import type { Profile } from '../domain/types.js';
import * as profileService from '../profile/profile.service.js';
import type { CreateUserInput, UpdateUserInput, UserAccountStatus } from './users.schemas.js';
import { buildLocationLabel } from '../auth/login-enrichment.js';

/** One row in the admin's user list, and the shape the profile switcher reads. */
export interface AdminUserSummary {
  id: string;
  email: string;
  role: UserRole;
  status: UserAccountStatus;
  createdAt: string;
  /** Most recent successful sign-in, if any. */
  lastLoginAt: string | null;
  /** IP from that last sign-in, when recorded. */
  lastLoginIp: string | null;
  /** Place line from that last sign-in, when GeoIP resolved. */
  lastLoginLocation: string | null;
  firstName: string;
  lastName: string;
  /** `"First Last"`, or the email when the profile has no name yet. */
  displayName: string;
  photoUrl?: string;
  dateOfBirth: string;
  /** How many applications are filed under this account. */
  bidCount: number;
}

export interface AdminUserDetail extends AdminUserSummary {
  profile: Profile;
}

/** One successful sign-in, newest first from `listLoginHistory`. */
export interface LoginHistoryEntry {
  id: string;
  ip: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  isp: string | null;
  org: string | null;
  locationLabel: string | null;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  createdAt: string;
}

const LOGIN_HISTORY_LIMIT = 50;

function toApiRole(role: 'USER' | 'ADMIN'): UserRole {
  return role === 'ADMIN' ? 'admin' : 'user';
}

function toApiStatus(status: 'ACTIVE' | 'SUSPENDED'): UserAccountStatus {
  return status === 'SUSPENDED' ? 'suspended' : 'active';
}

function toDbStatus(status: UserAccountStatus): 'ACTIVE' | 'SUSPENDED' {
  return status === 'suspended' ? 'SUSPENDED' : 'ACTIVE';
}

const summarySelect = {
  id: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
  profile: {
    select: { firstName: true, lastName: true, dateOfBirth: true, photoKey: true },
  },
  loginHistory: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      createdAt: true,
      ip: true,
      locationLabel: true,
      city: true,
      region: true,
      country: true,
      countryCode: true,
    },
  },
  _count: { select: { bids: true } },
} as const;

type SummaryRow = {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: Date;
  profile: {
    firstName: string;
    lastName: string;
    dateOfBirth: Date | null;
    photoKey: string | null;
  } | null;
  loginHistory: Array<{
    createdAt: Date;
    ip: string | null;
    locationLabel: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    countryCode: string | null;
  }>;
  _count: { bids: number };
};

async function toSummary(row: SummaryRow): Promise<AdminUserSummary> {
  const firstName = row.profile?.firstName ?? '';
  const lastName = row.profile?.lastName ?? '';
  const photoUrl = await signPhotoUrl(row.profile?.photoKey);
  const last = row.loginHistory[0];
  const lastLoginLocation = last
    ? buildLocationLabel({
        city: last.city,
        region: last.region,
        regionCode: null,
        country: last.country,
        countryCode: last.countryCode,
      }) || last.locationLabel
    : null;

  return {
    id: row.id,
    email: row.email,
    role: toApiRole(row.role),
    status: toApiStatus(row.status),
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: last?.createdAt.toISOString() ?? null,
    lastLoginIp: last?.ip ?? null,
    lastLoginLocation,
    firstName,
    lastName,
    // The switcher has to label every account, including one whose profile has
    // not been filled in yet — an empty entry in that list is unpickable.
    displayName: `${firstName} ${lastName}`.trim() || row.email,
    ...(photoUrl ? { photoUrl } : {}),
    dateOfBirth: row.profile?.dateOfBirth ? formatDateOnly(row.profile.dateOfBirth) : '',
    bidCount: row._count.bids,
  };
}

export async function listUsers(): Promise<AdminUserSummary[]> {
  const rows = await prisma.user.findMany({
    select: summarySelect,
    orderBy: [{ createdAt: 'asc' }],
  });

  return Promise.all(rows.map(toSummary));
}

async function findSummaryOrThrow(userId: string): Promise<AdminUserSummary> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: summarySelect });
  if (!row) throw new NotFoundError('No such account.');
  return toSummary(row);
}

export async function getUser(userId: string): Promise<AdminUserDetail> {
  const [summary, profile] = await Promise.all([
    findSummaryOrThrow(userId),
    profileService.getProfile(userId),
  ]);

  return { ...summary, profile };
}

/**
 * Recent successful sign-ins for one account (newest first). Cap keeps the
 * modal light; older rows remain in the table for later export if needed.
 */
export async function listLoginHistory(userId: string): Promise<LoginHistoryEntry[]> {
  const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!exists) throw new NotFoundError('No such account.');

  const rows = await prisma.loginHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: LOGIN_HISTORY_LIMIT,
    select: {
      id: true,
      ip: true,
      userAgent: true,
      acceptLanguage: true,
      country: true,
      countryCode: true,
      region: true,
      city: true,
      latitude: true,
      longitude: true,
      timezone: true,
      isp: true,
      org: true,
      locationLabel: true,
      browser: true,
      os: true,
      deviceType: true,
      createdAt: true,
    },
  });

  return rows.map(row => ({
    id: row.id,
    ip: row.ip,
    userAgent: row.userAgent,
    acceptLanguage: row.acceptLanguage,
    country: row.country,
    countryCode: row.countryCode,
    region: row.region,
    city: row.city,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
    isp: row.isp,
    org: row.org,
    locationLabel:
      buildLocationLabel({
        city: row.city,
        region: row.region,
        regionCode: null,
        country: row.country,
        countryCode: row.countryCode,
      }) || row.locationLabel,
    browser: row.browser,
    os: row.os,
    deviceType: row.deviceType,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Creates a platform User with credentials only (always role `user`).
 *
 * An empty legacy Resume stub and default settings are attached so existing
 * Resume / settings routes do not 404. The stub does **not** copy the login
 * email — application Profile contact email is set when an admin creates a
 * Profile and shares it.
 */
export async function createUser(input: CreateUserInput): Promise<AdminUserDetail> {
  const email = input.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new ConflictError('An account with that email already exists.');

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(input.password),
      role: 'USER',
      profile: {
        create: {},
      },
      settings: { create: {} },
    },
    select: { id: true },
  });

  return getUser(user.id);
}

export async function updateUser(
  actorId: string,
  userId: string,
  input: UpdateUserInput,
): Promise<AdminUserDetail> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  });
  if (!existing) throw new NotFoundError('No such account.');

  if (input.status === 'suspended') {
    if (userId === actorId) {
      throw new BadRequestError('You cannot suspend your own account.');
    }
    if (existing.role === 'ADMIN') {
      throw new BadRequestError('The administrator account cannot be suspended.');
    }
  }

  const email = input.email?.trim().toLowerCase();
  if (email) {
    const clash = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (clash && clash.id !== userId) {
      throw new ConflictError('Another account already uses that email.');
    }
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      ...(email ? { email } : {}),
      ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
      ...(input.status ? { status: toDbStatus(input.status) } : {}),
    },
  });

  // Password change or suspend: end live sessions so a stolen/open browser
  // cannot keep using the account.
  if (input.password || input.status === 'suspended') {
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  return getUser(userId);
}

/**
 * Deletes an account and everything it owns — bids, interviews, commitments,
 * profile, settings, sessions — through the schema's cascades.
 *
 * The photo objects in the bucket are deliberately *not* chased down here. A
 * bucket delete can fail, and half-deleting an account because S3 was briefly
 * unreachable is worse than leaving an orphan object behind.
 *
 * The sole Admin cannot be deleted.
 */
export async function deleteUser(actorId: string, userId: string): Promise<void> {
  if (userId === actorId) {
    throw new BadRequestError('You cannot delete your own account.');
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!target) throw new NotFoundError('No such account.');
  if (target.role === 'ADMIN') {
    throw new BadRequestError(
      'The administrator account cannot be deleted. Promote a different admin with yarn admin if you need to replace it.',
    );
  }

  const { count } = await prisma.user.deleteMany({ where: { id: userId } });
  if (count === 0) throw new NotFoundError('No such account.');
}
