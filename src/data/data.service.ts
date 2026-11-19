import { prisma } from '../prisma.js';
import { UnprocessableEntityError } from '../http/errors.js';
import { parseDateOnly, parseNaiveDateTime } from '../domain/dates.js';
import { toDbRateType, toDbStatus } from '../domain/status.js';
import { isInterviewStage } from '../domain/types.js';
import type { DataBundle } from '../domain/types.js';
import { bidInclude, toApiBid } from '../bids/bids.mapper.js';
import { nextBidNumber } from '../bids/bid-number.js';
import type { UserRole } from '../auth/auth.schemas.js';
import * as profileService from '../profile/profile.service.js';
import * as settingsService from '../settings/settings.service.js';
import type { ImportBundle, ImportQuery } from './data.schemas.js';

export interface ImportResult {
  mode: ImportQuery['mode'];
  bidsImported: number;
  bidsDeleted: number;
  profileImported: boolean;
  settingsImported: boolean;
}

/** The complete dataset for one user, in the frontend's own backup format. */
export async function exportData(userId: string): Promise<DataBundle> {
  const [rows, profile, settings] = await Promise.all([
    prisma.bid.findMany({
      where: { userId },
      include: bidInclude,
      orderBy: [{ bidDate: 'desc' }, { createdAt: 'desc' }],
    }),
    profileService.getProfile(userId),
    settingsService.getSettings(userId),
  ]);

  // `toApiBid` takes a photo URL as its second argument, so it cannot be handed
  // to `map` directly — the index would arrive as the URL. An export carries no
  // candidate photos anyway: it is this account's own data, restored into an
  // account that supplies its own.
  return { bids: rows.map((row) => toApiBid(row)), profile, settings };
}

export async function importData(
  userId: string,
  bundle: ImportBundle,
  query: ImportQuery,
  role: UserRole,
): Promise<ImportResult> {
  // Validate the whole batch before writing any of it, so a bad row near the
  // end cannot leave a half-restored backup behind.
  bundle.bids.forEach((bid, index) => {
    if (!isInterviewStage(bid.status)) return;
    if (bid.interviews?.some((round) => round.stage === bid.status)) return;

    throw new UnprocessableEntityError(
      `Bid ${index} has interview status "${bid.status}" but no matching interview round.`,
      [{ path: `bids.${index}.interviews`, message: `Missing a round for stage "${bid.status}".` }],
    );
  });

  const result = await prisma.$transaction(async (tx) => {
    let bidsDeleted = 0;
    if (query.mode === 'replace') {
      ({ count: bidsDeleted } = await tx.bid.deleteMany({ where: { userId } }));
    }

    // A restored backup is filed under the account itself, with no Profile, and
    // numbered on from whatever that scope already holds — from 1 after a
    // `replace`, which has just emptied it.
    let number = await nextBidNumber(tx, { userId, profileId: null });

    for (const bid of bundle.bids) {
      await tx.bid.create({
        data: {
          userId,
          number: number++,
          company: bid.company,
          role: bid.role,
          jobUrl: bid.jobUrl ?? null,
          location: bid.location,
          jobDescription: bid.jobDescription ?? null,
          rateType: bid.rateType ? toDbRateType(bid.rateType) : null,
          rateAmount: bid.rateAmount ?? null,
          bidDate: parseDateOnly(bid.bidDate),
          status: toDbStatus(bid.status),
          // A backup does not say when it was sent; the day it was saved is the
          // best record, as the migration that added the column took it.
          appliedAt: ['Draft', 'Skip', 'Expired'].includes(bid.status)
            ? null
            : new Date(`${bid.bidDate}T12:00:00Z`),
          followUpDate: bid.followUpDate ? parseDateOnly(bid.followUpDate) : null,
          resumeVersion: bid.resumeVersion ?? null,
          notes: bid.notes ?? null,
          interviews: {
            create: (bid.interviews ?? []).map((round) => ({
              stage: toDbStatus(round.stage),
              dateTime: parseNaiveDateTime(round.dateTime),
            })),
          },
          ...(bid.commitmentDetails
            ? {
                commitment: {
                  create: {
                    startDate: parseDateOnly(bid.commitmentDetails.startDate),
                    endDate: bid.commitmentDetails.endDate
                      ? parseDateOnly(bid.commitmentDetails.endDate)
                      : null,
                    contractType: bid.commitmentDetails.contractType,
                    agreedRate: bid.commitmentDetails.agreedRate,
                  },
                },
              }
            : {}),
        },
      });
    }

    return { bidsDeleted, bidsImported: bundle.bids.length };
  });

  // Outside the bid transaction: these are independent singletons, and a
  // profile that fails to apply should not roll back a successful bid restore.
  if (bundle.profile) await profileService.updateProfile(userId, bundle.profile);
  // The role travels with it: a backup carries a `dailyBidGoal`, and restoring
  // one must not be a way around the rule that only an admin sets it.
  if (bundle.settings) await settingsService.updateSettings(userId, bundle.settings, role);

  return {
    mode: query.mode,
    ...result,
    profileImported: Boolean(bundle.profile),
    settingsImported: Boolean(bundle.settings),
  };
}

/**
 * The server-side equivalent of the frontend's "Clear All Data" button. Deletes
 * the account's bids and resets its two singletons; the account itself stays.
 */
export async function resetData(userId: string): Promise<{ bidsDeleted: number }> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.bid.deleteMany({ where: { userId } });

    const profile = await tx.profile.findUnique({ where: { userId }, select: { id: true } });
    if (profile) {
      await tx.workExperience.deleteMany({ where: { profileId: profile.id } });
      await tx.education.deleteMany({ where: { profileId: profile.id } });
      await tx.profile.update({
        where: { userId },
        data: {
          firstName: '',
          middleName: '',
          lastName: '',
          hasPreferredName: false,
          preferredFirstName: '',
          preferredLastName: '',
          dateOfBirth: null,
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
        },
      });
    }

    await tx.settings.updateMany({
      where: { userId },
      data: { dailyBidGoal: 100, theme: 'LIGHT' },
    });

    return { bidsDeleted: count };
  });
}
