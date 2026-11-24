/**
 * First-class application Profiles — created by an admin, then shared with
 * Users. Distinct from platform logins (`/api/admin/users`).
 */
import { prisma } from '../prisma.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { signPhotoUrl } from '../storage/s3.client.js';
import type { Profile } from '../domain/types.js';
import * as profileService from '../profile/profile.service.js';
import type { CreateProfileInput, SetProfileSharesInput } from './profiles.schemas.js';

export interface SharedUserSummary {
  id: string;
  email: string;
  /** `"First Last"` from the account stub when filled, otherwise the login email. */
  displayName: string;
}

export interface AdminProfileSummary {
  id: string;
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  phone: string;
  displayName: string;
  /** Latest / current job title when work history exists. */
  headline: string;
  /** Completeness: required contact/address (70%) + LinkedIn/work/education (30%). */
  completionPercent: number;
  photoUrl?: string;
  createdAt: string;
  updatedAt: string;
  sharedWith: SharedUserSummary[];
}

export interface AdminProfileDetail extends AdminProfileSummary {
  profile: Profile;
}

function displayNameOf(firstName: string, lastName: string, email: string): string {
  return `${firstName} ${lastName}`.trim() || email.trim() || 'Untitled profile';
}

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

/** A work row counts only when it has the fields the create form marks required. */
function isMeaningfulWorkExperience(entry: {
  company: string;
  title: string;
  startDate: string | null;
}): boolean {
  return hasText(entry.company) && hasText(entry.title) && hasText(entry.startDate);
}

/** An education row counts only when university + degree are filled. */
function isMeaningfulEducation(entry: { university: string; degree: string }): boolean {
  return hasText(entry.university) && hasText(entry.degree);
}

/**
 * Profile completion for the Profiles cards.
 *
 * Required contact/address fields (same as Create Profile submit) are 70% of
 * the score. Enrichment — LinkedIn plus at least one real work and education
 * entry — is the remaining 30%. Photo is omitted until the admin profile
 * editor can upload one; otherwise profiles could never reach 100%.
 */
function completionPercentOf(row: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  timezone: string;
  linkedinUrl: string;
  workExperience: Array<{ company: string; title: string; startDate: string | null }>;
  education: Array<{ university: string; degree: string }>;
}): number {
  const required = [
    row.firstName,
    row.lastName,
    row.email,
    row.phone,
    row.addressLine,
    row.city,
    row.state,
    row.zipCode,
    row.country,
    row.timezone,
  ];
  const requiredFilled = required.filter(hasText).length;
  const requiredScore = requiredFilled / required.length;

  const enrichment = [
    hasText(row.linkedinUrl),
    row.workExperience.some(isMeaningfulWorkExperience),
    row.education.some(isMeaningfulEducation),
  ];
  const enrichmentFilled = enrichment.filter(Boolean).length;
  const enrichmentScore = enrichmentFilled / enrichment.length;

  return Math.round((requiredScore * 0.7 + enrichmentScore * 0.3) * 100);
}

function toSharedUser(row: {
  id: string;
  email: string;
  profile: { firstName: string; lastName: string } | null;
}): SharedUserSummary {
  const firstName = row.profile?.firstName ?? '';
  const lastName = row.profile?.lastName ?? '';
  return {
    id: row.id,
    email: row.email,
    displayName: `${firstName} ${lastName}`.trim() || row.email,
  };
}

async function toSummary(row: {
  id: string;
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  timezone: string;
  linkedinUrl: string;
  photoKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  workExperience: Array<{
    company: string;
    title: string;
    startDate: string | null;
  }>;
  education: Array<{ university: string; degree: string }>;
  shares: Array<{
    user: {
      id: string;
      email: string;
      profile: { firstName: string; lastName: string } | null;
    };
  }>;
}): Promise<AdminProfileSummary> {
  const photoUrl = await signPhotoUrl(row.photoKey);
  const headline =
    row.workExperience.find(entry => hasText(entry.title))?.title.trim() ?? '';
  return {
    id: row.id,
    firstName: row.firstName,
    middleName: row.middleName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    displayName: displayNameOf(row.firstName, row.lastName, row.email),
    headline,
    completionPercent: completionPercentOf(row),
    ...(photoUrl ? { photoUrl } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sharedWith: row.shares.map(share => toSharedUser(share.user)),
  };
}

const listInclude = {
  workExperience: {
    orderBy: { position: 'asc' as const },
    select: { company: true, title: true, startDate: true },
  },
  education: {
    orderBy: { position: 'asc' as const },
    select: { university: true, degree: true },
  },
  shares: {
    include: {
      user: {
        select: {
          id: true,
          email: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

/**
 * Application profiles for the admin Profiles page.
 *
 * Only real application identities: standalone profiles (created here) or
 * legacy rows that already have a candidate name. Empty login stubs stay hidden.
 */
export async function listProfiles(): Promise<AdminProfileSummary[]> {
  const rows = await prisma.profile.findMany({
    include: listInclude,
    orderBy: [{ updatedAt: 'desc' }],
  });

  const visible = rows.filter(row => {
    if (row.userId === null) return true;
    return Boolean(row.firstName.trim() && row.lastName.trim());
  });

  return Promise.all(visible.map(toSummary));
}

export async function getProfile(profileId: string): Promise<AdminProfileDetail> {
  const row = await prisma.profile.findUnique({
    where: { id: profileId },
    include: listInclude,
  });
  if (!row) throw new NotFoundError('No such profile.');

  const [summary, profile] = await Promise.all([
    toSummary(row),
    profileService.getProfileById(profileId),
  ]);

  return { ...summary, profile };
}

export async function createProfile(input: CreateProfileInput): Promise<AdminProfileDetail> {
  const { id } = await profileService.createStandaloneProfile(input);
  return getProfile(id);
}

export async function updateProfile(
  profileId: string,
  input: CreateProfileInput,
): Promise<AdminProfileDetail> {
  await profileService.updateProfileById(profileId, input);
  return getProfile(profileId);
}

/**
 * Replaces the share set for one Profile. Only role `USER` accounts may be
 * granted access — the sole Admin is not a candidate identity holder.
 */
export async function setProfileShares(
  profileId: string,
  input: SetProfileSharesInput,
): Promise<AdminProfileDetail> {
  const existing = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('No such profile.');

  const uniqueIds = [...new Set(input.userIds)];

  if (uniqueIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, role: true },
    });
    if (users.length !== uniqueIds.length) {
      throw new BadRequestError('One or more selected accounts do not exist.');
    }
    if (users.some(user => user.role !== 'USER')) {
      throw new BadRequestError('Profiles can only be shared with User accounts.');
    }
  }

  await prisma.$transaction(async tx => {
    await tx.profileShare.deleteMany({ where: { profileId } });
    if (uniqueIds.length > 0) {
      await tx.profileShare.createMany({
        data: uniqueIds.map(userId => ({ profileId, userId })),
      });
    }
  });

  return getProfile(profileId);
}

export async function deleteProfile(profileId: string): Promise<void> {
  await profileService.deleteProfileById(profileId);
}

/**
 * Whether `userId` has been granted this Profile via `profile_shares`.
 * Used by bid filing/scoping so a User can only act on profiles shared with them.
 */
export async function isSharedWith(userId: string, profileId: string): Promise<boolean> {
  const share = await prisma.profileShare.findUnique({
    where: { profileId_userId: { profileId, userId } },
    select: { profileId: true },
  });
  return share !== null;
}

/**
 * Profiles an admin has shared with this User. `sharedWith` is cleared — a
 * candidate must not see who else holds the same identity.
 */
export async function listSharedWith(userId: string): Promise<AdminProfileSummary[]> {
  const rows = await prisma.profile.findMany({
    where: { shares: { some: { userId } } },
    include: listInclude,
    orderBy: [{ updatedAt: 'desc' }],
  });

  const summaries = await Promise.all(rows.map(toSummary));
  return summaries.map(summary => ({ ...summary, sharedWith: [] }));
}

/**
 * 404 unless this actor may edit the Profile: an admin any Profile, a Profile
 * token its own, a User one shared with them or their own.
 */
export async function assertCanEdit(
  actor: { id: string; role: string; profileId?: string },
  profileId: string,
): Promise<void> {
  if (actor.role === 'admin' && !actor.profileId) return;
  if (actor.profileId) {
    if (actor.profileId.toLowerCase() === profileId.toLowerCase()) return;
    throw new NotFoundError('No such profile.');
  }
  if (await isSharedWith(actor.id, profileId)) return;
  const own = await prisma.profile.findFirst({ where: { id: profileId, userId: actor.id }, select: { id: true } });
  if (!own) throw new NotFoundError('No such profile.');
}

export async function getSharedWith(
  userId: string,
  profileId: string,
): Promise<AdminProfileDetail> {
  const shared = await isSharedWith(userId, profileId);
  if (!shared) throw new NotFoundError('No such profile.');

  const detail = await getProfile(profileId);
  return { ...detail, sharedWith: [] };
}

/**
 * Replace which Profiles are shared with one User. Inverse of
 * `setProfileShares` — the Users page assigns Profiles to an account.
 */
export async function setUserSharedProfiles(
  userId: string,
  profileIds: string[],
): Promise<AdminProfileSummary[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
  if (!user) throw new NotFoundError('No such account.');
  if (user.role !== 'USER') {
    throw new BadRequestError('Profiles can only be shared with User accounts.');
  }

  const uniqueIds = [...new Set(profileIds)];

  if (uniqueIds.length > 0) {
    const profiles = await prisma.profile.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    });
    if (profiles.length !== uniqueIds.length) {
      throw new BadRequestError('One or more selected profiles do not exist.');
    }
  }

  await prisma.$transaction(async tx => {
    await tx.profileShare.deleteMany({ where: { userId } });
    if (uniqueIds.length > 0) {
      await tx.profileShare.createMany({
        data: uniqueIds.map(profileId => ({ profileId, userId })),
      });
    }
  });

  return listSharedWith(userId);
}
