import { randomUUID } from 'node:crypto';
import { prisma } from '../prisma.js';
import { formatDateOnly, parseDateOnly } from '../domain/dates.js';
import { NotFoundError } from '../http/errors.js';
import { deletePhoto, signPhotoUrl, uploadPhoto } from '../storage/s3.client.js';
import type { Education, Profile, WorkExperience } from '../domain/types.js';
import type { PrismaTx } from '../prisma.js';
import type { ProfileInput } from './profile.schemas.js';
import { resolveTemplateId } from '../resume/maker/templates.js';

const profileInclude = {
  workExperience: { orderBy: { position: 'asc' } },
  education: { orderBy: { position: 'asc' } },
} as const;

type ProfileRow = {
  id: string;
  photoKey: string | null;
  firstName: string;
  middleName: string;
  lastName: string;
  hasPreferredName: boolean;
  preferredFirstName: string;
  preferredLastName: string;
  dateOfBirth: Date | null;
  resumeTemplateId: string;
  location: string;
  addressLine: string;
  city: string;
  state: string;
  zipCode: string;
  county: string;
  country: string;
  timezone: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  otherUrl: string;
  email: string;
  phone: string;
  authorizedCountries: string[];
  gender: string;
  ethnicity: string;
  disabilityStatus: string;
  veteranStatus: string;
  lgbtqIdentity: string;
  birthYear: string;
  securityClearance: string;
  drugTestWillingness: string;
  noticePeriod: string;
  openToRelocation: string;
  inPersonAvailability: string;
  requireAccommodations: string;
  workExperience: {
    id: string;
    company: string;
    title: string;
    location: string;
    startDate: string | null;
    endDate: string | null;
  }[];
  education: {
    id: string;
    degree: string;
    major: string;
    university: string;
    location: string;
    startDate: string | null;
    endDate: string | null;
  }[];
};

export function emptyProfile(): Profile {
  return {
    firstName: '',
    middleName: '',
    lastName: '',
    hasPreferredName: false,
    preferredFirstName: '',
    preferredLastName: '',
    dateOfBirth: '',
    resumeTemplateId: 'default.docx',
    location: '',
    addressLine: '',
    city: '',
    state: '',
    zipCode: '',
    county: '',
    country: '',
    timezone: '',
    linkedinUrl: '',
    githubUrl: '',
    portfolioUrl: '',
    otherUrl: '',
    email: '',
    phone: '',
    authorizedCountries: [],
    gender: '',
    ethnicity: '',
    disabilityStatus: '',
    veteranStatus: '',
    lgbtqIdentity: '',
    birthYear: '',
    securityClearance: '',
    drugTestWillingness: '',
    noticePeriod: '',
    openToRelocation: '',
    inPersonAvailability: '',
    requireAccommodations: '',
    workExperience: [],
    education: [],
  };
}

/**
 * Resume templates still read the free-text `location` line. Prefer a compact
 * city/state label when structured fields are filled in.
 */
function deriveLocation(input: ProfileInput): string {
  if (input.location.trim()) return input.location.trim();
  const cityState = [input.city, input.state].map((part) => part.trim()).filter(Boolean);
  if (cityState.length > 0) return cityState.join(', ');
  return input.addressLine.trim();
}

/**
 * The frontend's `Profile` type has no nullable fields — blank means `''` (and
 * `null` only for a still-current role's `endDate`). Nulls in the database are
 * normalised back to that shape here.
 *
 * Async because the photo is a stored object key, not a URL: a link is signed
 * fresh on every read so that a profile sitting in a client-side cache never
 * starts serving expired `src`s.
 */
async function toApiProfile(row: ProfileRow): Promise<Profile> {
  const workExperience: WorkExperience[] = row.workExperience.map((entry) => ({
    id: entry.id,
    company: entry.company,
    title: entry.title,
    location: entry.location,
    startDate: entry.startDate ?? '',
    endDate: entry.endDate,
  }));

  const education: Education[] = row.education.map((entry) => ({
    id: entry.id,
    degree: entry.degree,
    major: entry.major,
    university: entry.university,
    location: entry.location,
    startDate: entry.startDate ?? '',
    endDate: entry.endDate,
  }));

  const photoUrl = await signPhotoUrl(row.photoKey);

  return {
    firstName: row.firstName,
    middleName: row.middleName,
    lastName: row.lastName,
    hasPreferredName: row.hasPreferredName,
    preferredFirstName: row.preferredFirstName,
    preferredLastName: row.preferredLastName,
    dateOfBirth: row.dateOfBirth ? formatDateOnly(row.dateOfBirth) : '',
    resumeTemplateId: row.resumeTemplateId,
    location: row.location,
    addressLine: row.addressLine,
    city: row.city,
    state: row.state,
    zipCode: row.zipCode,
    county: row.county,
    country: row.country,
    timezone: row.timezone,
    linkedinUrl: row.linkedinUrl,
    githubUrl: row.githubUrl,
    portfolioUrl: row.portfolioUrl,
    otherUrl: row.otherUrl,
    email: row.email,
    phone: row.phone,
    authorizedCountries: row.authorizedCountries ?? [],
    gender: row.gender,
    ethnicity: row.ethnicity,
    disabilityStatus: row.disabilityStatus,
    veteranStatus: row.veteranStatus,
    lgbtqIdentity: row.lgbtqIdentity,
    birthYear: row.birthYear,
    securityClearance: row.securityClearance,
    drugTestWillingness: row.drugTestWillingness,
    noticePeriod: row.noticePeriod,
    openToRelocation: row.openToRelocation,
    inPersonAvailability: row.inPersonAvailability,
    requireAccommodations: row.requireAccommodations,
    ...(photoUrl ? { photoUrl } : {}),
    workExperience,
    education,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client generates child ids with `crypto.randomUUID()` and we honour them
 * so its local React state keys stay stable across a save. Seed rows carry ids
 * like `"1"` though, which are not valid `uuid` column values — those get a
 * fresh server id.
 */
function resolveId(clientId: string | undefined): string {
  return clientId && UUID.test(clientId) ? clientId : randomUUID();
}

function optionalDate(value: string | null | undefined): Date | null {
  return value ? parseDateOnly(value) : null;
}

/**
 * The form sends `''` for a month it has not been given yet. The column is
 * nullable, and null is what "not set" means there.
 */
function blankToNull(value: string | null | undefined): string | null {
  return value ? value : null;
}

function scalarsFromInput(input: ProfileInput) {
  return {
    firstName: input.firstName,
    middleName: input.middleName,
    lastName: input.lastName,
    hasPreferredName: input.hasPreferredName,
    preferredFirstName: input.hasPreferredName ? input.preferredFirstName : '',
    preferredLastName: input.hasPreferredName ? input.preferredLastName : '',
    dateOfBirth: optionalDate(input.dateOfBirth),
    resumeTemplateId: input.resumeTemplateId,
    location: deriveLocation(input),
    addressLine: input.addressLine,
    city: input.city,
    state: input.state,
    zipCode: input.zipCode,
    county: input.county,
    country: input.country,
    timezone: input.timezone,
    linkedinUrl: input.linkedinUrl,
    githubUrl: input.githubUrl,
    portfolioUrl: input.portfolioUrl,
    otherUrl: input.otherUrl,
    email: input.email,
    phone: input.phone,
    authorizedCountries: input.authorizedCountries,
    gender: input.gender,
    ethnicity: input.ethnicity,
    disabilityStatus: input.disabilityStatus,
    veteranStatus: input.veteranStatus,
    lgbtqIdentity: input.lgbtqIdentity,
    birthYear: input.birthYear,
    securityClearance: input.securityClearance,
    drugTestWillingness: input.drugTestWillingness,
    noticePeriod: input.noticePeriod,
    openToRelocation: input.openToRelocation,
    inPersonAvailability: input.inPersonAvailability,
    requireAccommodations: input.requireAccommodations,
  };
}

async function rewriteChildren(
  tx: PrismaTx,
  profileId: string,
  input: ProfileInput,
): Promise<void> {
  await tx.workExperience.deleteMany({ where: { profileId } });
  await tx.education.deleteMany({ where: { profileId } });

  if (input.workExperience.length > 0) {
    await tx.workExperience.createMany({
      data: input.workExperience.map((entry, position) => ({
        id: resolveId(entry.id),
        profileId,
        company: entry.company,
        title: entry.title,
        location: entry.location,
        startDate: blankToNull(entry.startDate),
        endDate: blankToNull(entry.endDate),
        position,
      })),
    });
  }

  if (input.education.length > 0) {
    await tx.education.createMany({
      data: input.education.map((entry, position) => ({
        id: resolveId(entry.id),
        profileId,
        degree: entry.degree,
        major: entry.major,
        university: entry.university,
        location: entry.location,
        startDate: blankToNull(entry.startDate),
        endDate: blankToNull(entry.endDate),
        position,
      })),
    });
  }
}

export async function getProfile(userId: string): Promise<Profile> {
  const row = await prisma.profile.findUnique({
    where: { userId },
    include: profileInclude,
  });

  // A user always has a profile (created at registration), but a row deleted
  // out of band should still read as an empty profile rather than a 500.
  if (!row) return emptyProfile();

  return await toApiProfile(row);
}

export async function getProfileById(profileId: string): Promise<Profile> {
  const row = await prisma.profile.findUnique({
    where: { id: profileId },
    include: profileInclude,
  });
  if (!row) throw new NotFoundError('No such profile.');
  return await toApiProfile(row);
}

/**
 * Creates a standalone application Profile (no login assignment). Access is
 * granted later through `ProfileShare`.
 */
export async function createStandaloneProfile(input: ProfileInput): Promise<{
  id: string;
  profile: Profile;
}> {
  await resolveTemplateId(input.resumeTemplateId);
  const scalars = scalarsFromInput(input);

  const row = await prisma.$transaction(async (tx: PrismaTx) => {
    const profile = await tx.profile.create({
      data: scalars,
    });
    await rewriteChildren(tx, profile.id, input);
    return tx.profile.findUniqueOrThrow({
      where: { id: profile.id },
      include: profileInclude,
    });
  });

  return { id: row.id, profile: await toApiProfile(row) };
}

/**
 * A full replace, not a merge — the frontend's Settings page holds the whole
 * profile in local state and submits all of it. Children are rewritten inside a
 * transaction so a failure cannot leave a half-saved Resume.
 */
export async function updateProfile(userId: string, input: ProfileInput): Promise<Profile> {
  await resolveTemplateId(input.resumeTemplateId);
  const scalars = scalarsFromInput(input);

  const row = await prisma.$transaction(async (tx: PrismaTx) => {
    const profile = await tx.profile.upsert({
      where: { userId },
      create: { userId, ...scalars },
      update: scalars,
    });

    await rewriteChildren(tx, profile.id, input);

    return tx.profile.findUniqueOrThrow({
      where: { id: profile.id },
      include: profileInclude,
    });
  });

  return await toApiProfile(row);
}

export async function updateProfileById(
  profileId: string,
  input: ProfileInput,
): Promise<Profile> {
  await resolveTemplateId(input.resumeTemplateId);
  const existing = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('No such profile.');

  const scalars = scalarsFromInput(input);

  const row = await prisma.$transaction(async (tx: PrismaTx) => {
    await tx.profile.update({
      where: { id: profileId },
      data: scalars,
    });
    await rewriteChildren(tx, profileId, input);
    return tx.profile.findUniqueOrThrow({
      where: { id: profileId },
      include: profileInclude,
    });
  });

  return await toApiProfile(row);
}

export async function deleteProfileById(profileId: string): Promise<void> {
  const existing = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true, photoKey: true },
  });
  if (!existing) throw new NotFoundError('No such profile.');

  await prisma.profile.delete({ where: { id: profileId } });
  await deletePhoto(existing.photoKey);
}

/**
 * Replaces the candidate's photo.
 *
 * The bucket is written first and the row second, so a failed upload leaves the
 * old photo in place rather than a profile pointing at nothing. The object the
 * row used to name is deleted afterwards and its failure is swallowed — an
 * orphan in a bucket is cheaper than a 500 on a save that already succeeded.
 */
export async function replacePhoto(
  userId: string,
  body: Buffer,
  contentType: string,
): Promise<Profile> {
  const existing = await prisma.profile.findUnique({
    where: { userId },
    select: { id: true, photoKey: true },
  });

  if (!existing) throw new NotFoundError('This account has no profile to attach a photo to.');

  const { key } = await uploadPhoto(userId, body, contentType);

  const row = await prisma.profile.update({
    where: { id: existing.id },
    data: { photoKey: key },
    include: profileInclude,
  });

  await deletePhoto(existing.photoKey);

  return await toApiProfile(row);
}

export async function replacePhotoById(
  profileId: string,
  body: Buffer,
  contentType: string,
): Promise<Profile> {
  const existing = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true, photoKey: true },
  });
  if (!existing) throw new NotFoundError('No such profile.');

  const { key } = await uploadPhoto(profileId, body, contentType);

  const row = await prisma.profile.update({
    where: { id: existing.id },
    data: { photoKey: key },
    include: profileInclude,
  });

  await deletePhoto(existing.photoKey);

  return await toApiProfile(row);
}

/** Removes the photo. Deleting one that is not there is not an error. */
export async function removePhoto(userId: string): Promise<Profile> {
  const existing = await prisma.profile.findUnique({
    where: { userId },
    select: { id: true, photoKey: true },
  });

  if (!existing) throw new NotFoundError('This account has no profile.');

  const row = await prisma.profile.update({
    where: { id: existing.id },
    data: { photoKey: null },
    include: profileInclude,
  });

  await deletePhoto(existing.photoKey);

  return await toApiProfile(row);
}

export async function removePhotoById(profileId: string): Promise<Profile> {
  const existing = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true, photoKey: true },
  });
  if (!existing) throw new NotFoundError('No such profile.');

  const row = await prisma.profile.update({
    where: { id: existing.id },
    data: { photoKey: null },
    include: profileInclude,
  });

  await deletePhoto(existing.photoKey);

  return await toApiProfile(row);
}
