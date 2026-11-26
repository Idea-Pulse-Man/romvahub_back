import { createHash } from 'node:crypto';
import { Prisma as PrismaTypes } from '../generated/prisma/client.js';
import { jobUrlKey } from '../domain/job-url.js';
import { companyKey } from '../domain/company.js';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import {
  BadRequestError,
  DuplicateApplicationError,
  DuplicateProofError,
  NotFoundError,
} from '../http/errors.js';
import { isAdmin, type Actor } from '../auth/actor.js';
import { formatDateOnly, parseDateOnly, parseNaiveDateTime } from '../domain/dates.js';
import { fromDbStatus, toDbRateType, toDbStatus } from '../domain/status.js';
import {
  BID_STATUSES,
  type Bid,
  type BidPage,
  type BidSort,
  type BidStatus,
  type InterviewRound,
  type PipelineBoard,
  type ProofMatch,
  type ResumeFileFormat,
} from '../domain/types.js';
import { deletePhoto, signPhotoUrl, uploadProof } from '../storage/s3.client.js';
import {
  fingerprintDistance,
  fingerprintImage,
  isSameScreenshot,
  parseFingerprint,
  type ProofFingerprint,
} from '../proof/fingerprint.js';
import { bidInclude, candidatePhotoKey, toApiBid, type BidRow } from './bids.mapper.js';
import { HAS_RESUME, NO_RESUME } from '../resume/store/resume-store.js';
import { dropCopiesQuietly, dropKept } from '../resume/store/folder.js';
import { filesFollowStatus } from '../resume/store/file-rules.js';
import { bidScopeWhere, lockBidScope, nextBidNumber, type BidScope } from './bid-number.js';
import { ChatTranscriptSchema, type ChatMessage } from '../questions/questions.schemas.js';
import * as profilesService from '../admin/profiles.service.js';
import {
  DEFAULT_PAGE_SIZE,
  type BulkDeleteInput,
  type BulkStatusInput,
  type CreateBidInput,
  type ListBidsQuery,
  type PipelineQuery,
  type UpdateBidInput,
} from './bids.schemas.js';

/**
 * Rows to wire shapes, signing each distinct candidate photo once.
 *
 * An admin's list spans every profile, so a fifty-row page can carry six
 * candidates — six signatures rather than fifty. Signing is local HMAC either
 * way, but the map is what keeps the same photo from being signed to six
 * different URLs on one page, which would defeat any caching the browser does.
 */
async function mapBids(rows: BidRow[]): Promise<Bid[]> {
  const keys = [...new Set(rows.map(candidatePhotoKey).filter((key): key is string => !!key))];
  const signed = new Map(
    await Promise.all(keys.map(async (key) => [key, await signPhotoUrl(key)] as const)),
  );
  // The proof screenshot is one per row, so there is nothing to dedupe; it is
  // signed alongside for the same reason the photo is — signing is local, and
  // the table shows the link on every row.
  const proofs = await Promise.all(rows.map((row) => signPhotoUrl(row.proofKey)));

  return rows.map((row, index) => {
    const key = candidatePhotoKey(row);
    return toApiBid(row, key ? signed.get(key) : undefined, proofs[index]);
  });
}

/** One row, for the endpoints that answer with a single bid. */
async function mapBid(row: BidRow): Promise<Bid> {
  const [bid] = await mapBids([row]);
  return bid as Bid;
}

/**
 * Business rule 2: one interview round per stage. Re-entering a stage
 * overwrites its round rather than adding a duplicate, so a payload listing the
 * same stage twice keeps only the last entry.
 */
function dedupeByStage(rounds: readonly InterviewRound[]): InterviewRound[] {
  const byStage = new Map<BidStatus, InterviewRound>();
  for (const round of rounds) byStage.set(round.stage, round);
  return [...byStage.values()];
}

/**
 * Business rule 1 used to say an interview stage could not be entered without
 * a scheduled date and time. The Pipeline board's interview steps replaced it:
 * a process is often known to be under way before any date is ("TBD"), so an
 * interview stage no longer needs a round. A round that *is* given is still
 * kept, one per stage (rule 2).
 */

function toInterviewCreateData(rounds: readonly InterviewRound[]) {
  return rounds.map((round) => ({
    stage: toDbStatus(round.stage),
    dateTime: parseNaiveDateTime(round.dateTime),
  }));
}

function toCommitmentData(details: NonNullable<CreateBidInput['commitmentDetails']>) {
  return {
    startDate: parseDateOnly(details.startDate),
    endDate: details.endDate ? parseDateOnly(details.endDate) : null,
    contractType: details.contractType,
    agreedRate: details.agreedRate,
  };
}

/**
 * The posting time as sent, or null. A time in the future (a board's clock, or
 * a timezone read wrongly) is taken as "now" — it cannot have been posted later
 * than it was saved.
 */
function parsePostedAt(value: string | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const now = new Date();
  return at > now ? now : at;
}

/**
 * `appliedAt` for an application moving to `status`: kept once set, set now
 * the first time it is sent, cleared when it goes back to Draft or Skip.
 * Expired closes a Draft automatically, so it leaves the value as it was.
 */
function appliedAtFor(status: BidStatus, current: Date | null, now = new Date()): Date | null {
  if (status === 'Draft' || status === 'Skip') return null;
  if (status === 'Expired') return current;
  return current ?? now;
}

/** Scalar columns shared by create and update. Only defined keys are emitted. */
function toScalarData(input: UpdateBidInput): PrismaTypes.BidUncheckedUpdateInput {
  const data: PrismaTypes.BidUncheckedUpdateInput = {};

  if (input.company !== undefined) data.company = input.company;
  if (input.role !== undefined) data.role = input.role;
  if (input.location !== undefined) data.location = input.location;
  if (input.status !== undefined) data.status = toDbStatus(input.status);
  if (input.bidDate !== undefined) data.bidDate = parseDateOnly(input.bidDate);
  if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null;

  // Nullable columns: an explicitly-supplied blank clears them.
  if ('jobUrl' in input) data.jobUrl = input.jobUrl ?? null;
  if ('jobDescription' in input) data.jobDescription = input.jobDescription ?? null;
  if ('postedAt' in input) data.postedAt = parsePostedAt(input.postedAt);
  if ('resumeVersion' in input) data.resumeVersion = input.resumeVersion ?? null;
  if ('notes' in input) data.notes = input.notes ?? null;
  if ('followUpDate' in input) {
    data.followUpDate = input.followUpDate ? parseDateOnly(input.followUpDate) : null;
  }
  if ('rateType' in input) data.rateType = input.rateType ? toDbRateType(input.rateType) : null;
  if ('rateAmount' in input) data.rateAmount = input.rateAmount ?? null;

  // A JSON column clears with Prisma's DbNull sentinel; a plain `null` would be
  // stored as the JSON value `null`, which reads back as "there is a Resume,
  // and it is null".
  if ('resumeDocument' in input) {
    data.resumeDocument = input.resumeDocument ?? PrismaTypes.DbNull;
  }

  if ('coverLetterDocument' in input) {
    data.coverLetterDocument = input.coverLetterDocument ?? PrismaTypes.DbNull;
  }

  // An empty array clears too, rather than storing `[]`. An application whose
  // conversation was cleared should read like one that never had a question
  // asked about it, not like one holding an empty transcript.
  if ('applicationChat' in input) {
    data.applicationChat = input.applicationChat?.length
      ? input.applicationChat
      : PrismaTypes.DbNull;
  }

  return data;
}

async function findRowOrThrow(actor: Actor, bidId: string): Promise<BidRow> {
  // Access is part of the lookup, so another account's id is a 404 rather
  // than a 403 — it does not confirm the row exists. An admin's scope is empty,
  // so for them the lookup is by id alone.
  const row = await prisma.bid.findFirst({
    where: { id: bidId, ...bidAccessScope(actor) },
    include: bidInclude,
  });
  if (!row) throw new NotFoundError('Bid not found.');
  return row;
}

/**
 * Which bids a caller may see or mutate.
 *
 * Admins: every row. Users: bids they own *and* every bid filed under a
 * Profile shared with them. That second branch is what keeps an admin's
 * Applications list for "William Kolega" and the User that Profile was shared
 * with looking at the same rows — `Bid.userId` is only a technical owner and
 * may be the admin who filed the application.
 */
/**
 * Throws the same 404 every bid route does unless the actor may see this bid.
 * For routes about a bid's parts (its interview steps) that need no more of it.
 */
export async function assertBidAccess(actor: Actor, bidId: string): Promise<void> {
  const row = await prisma.bid.findFirst({ where: { id: bidId, ...bidAccessScope(actor) }, select: { id: true } });
  if (!row) throw new NotFoundError('No such application.');
}

export function bidAccessScope(actor: Actor): PrismaTypes.BidWhereInput {
  // A Profile token (the extension, the agent): its Profile's applications only.
  if (actor.profileId) return { profileId: actor.profileId };
  if (isAdmin(actor)) return {};
  return {
    OR: [
      { userId: actor.id },
      { profile: { shares: { some: { userId: actor.id } } } },
    ],
  };
}

/** The filters of a list request as a Prisma `where`, scoped to the caller. */
async function listWhere(actor: Actor, query: ListBidsQuery): Promise<PrismaTypes.BidWhereInput> {
  const clauses: PrismaTypes.BidWhereInput[] = [bidAccessScope(actor)];

  const profile = profileScope(actor, query.profileId);
  if (profile.profileId) clauses.push(profile);

  if (query.status) clauses.push({ status: toDbStatus(query.status) });
  if (query.statuses?.length) clauses.push({ status: { in: query.statuses.map(toDbStatus) } });

  // Has a Resume: JSON, a stored or kept file, or a generated document — the same test as `hasResume` on a bid.
  if (query.hasResume === true) {
    clauses.push(HAS_RESUME);
  } else if (query.hasResume === false) {
    clauses.push(NO_RESUME);
  }

  if (query.needsRemake === true) clauses.push({ resumeCheckStatus: 'flagged' });
  else if (query.needsRemake === false) clauses.push({ NOT: [{ resumeCheckStatus: 'flagged' }] });

  // The same employer however it was written — "Acme", "ACME, Inc.", "The Acme
  // Company" — but the whole name rather than a substring: "Meta" must not
  // report an application at Metabase as a duplicate. See `companyKey`.
  //
  // Matched here rather than in SQL so there is one definition of "same
  // company", shared with the frontend's copy. Only the id and company of the
  // caller's own scope are read, which stays small.
  if (query.company) {
    const key = companyKey(query.company);
    const inScope = await prisma.bid.findMany({
      where: { AND: [...clauses] },
      select: { id: true, company: true },
    });
    clauses.push({
      id: { in: inScope.filter((row) => companyKey(row.company) === key).map((row) => row.id) },
    });
  }

  // The same posting by link, however the link was decorated. See `jobUrlKey`.
  // Like the company match, done here so there is one definition of it.
  if (query.jobUrl) {
    const key = jobUrlKey(query.jobUrl);
    const inScope = await prisma.bid.findMany({
      where: { AND: [...clauses, { jobUrl: { not: null } }] },
      select: { id: true, jobUrl: true },
    });
    clauses.push({
      id: { in: inScope.filter((row) => jobUrlKey(row.jobUrl ?? '') === key).map((row) => row.id) },
    });
  }

  if (query.from || query.to) {
    clauses.push({
      bidDate: {
        ...(query.from ? { gte: parseDateOnly(query.from) } : {}),
        ...(query.to ? { lte: parseDateOnly(query.to) } : {}),
      },
    });
  }

  if (query.search) {
    clauses.push({
      OR: [
        { company: { contains: query.search, mode: 'insensitive' } },
        { role: { contains: query.search, mode: 'insensitive' } },
      ],
    });
  }

  return clauses.length === 1 ? clauses[0]! : { AND: clauses };
}

/**
 * Profile scope for list / pipeline queries.
 *
 * Naming a Profile restricts the result to applications filed under it. For a
 * User this combines with `bidAccessScope`: an unshared id matches nothing.
 */
function profileScope(_actor: Actor, profileId: string | undefined): { profileId?: string } {
  if (!profileId) return {};
  return { profileId };
}

/**
 * Newest first, by whichever date the screen reads — or, for `number`, the
 * order the applications were filed in, which is what the Applications table
 * shows beside its "#" column.
 *
 * The id is the last tiebreaker on all three. Two applications imported in one
 * batch share a `createdAt` to the millisecond, and without a total order the
 * database is free to hand them back in either sequence — which, across two
 * page requests, is a row that appears twice and a row that never appears.
 */
function listOrderBy(sort: BidSort = 'bidDate'): PrismaTypes.BidOrderByWithRelationInput[] {
  // Numbers repeat across filing scopes (every Profile has a #1), so an admin's
  // unscoped list still needs the tiebreakers to be a total order.
  if (sort === 'number') return [{ number: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];

  const first: PrismaTypes.BidOrderByWithRelationInput =
    sort === 'updatedAt' ? { updatedAt: 'desc' } : { bidDate: 'desc' };
  return [first, { createdAt: 'desc' }, { id: 'desc' }];
}

/**
 * A short token that changes whenever the caller's applications do — one
 * added (the scraper extension saving a job), edited, moved or deleted.
 *
 * Open pages poll it every few seconds and refetch only when it moves, which
 * is how a job saved by the extension shows up without a reload. Polling
 * rather than a push stream because the API also runs as short-lived
 * serverless functions, which cannot hold a connection open; one indexed
 * count and max per poll is cheap where a full page of rows would not be.
 */
export async function bidsVersion(actor: Actor, query: { profileId?: string }): Promise<string> {
  const result = await prisma.bid.aggregate({
    where: await listWhere(actor, { profileId: query.profileId }),
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  return `${result._count._all}:${result._max.updatedAt?.getTime() ?? 0}`;
}

/** The whole list. What the Dashboard, the Calendar and the Commitments page read. */
export async function listBids(actor: Actor, query: ListBidsQuery = {}): Promise<Bid[]> {
  const rows = await prisma.bid.findMany({
    where: await listWhere(actor, query),
    include: bidInclude,
    orderBy: listOrderBy(query.sort),
  });

  return mapBids(rows);
}

/**
 * One page of the list, with the count behind it.
 *
 * The count and the page are read in one transaction so they describe the same
 * moment: a row deleted between the two would otherwise leave the table
 * announcing 51 applications and showing 50.
 */
export async function listBidsPage(actor: Actor, query: ListBidsQuery): Promise<BidPage> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const where = await listWhere(actor, query);

  // Two plain reads rather than one transaction: a transaction needs a
  // connection of its own within Prisma's wait, and a burst of list requests
  // on one serverless instance (one connection) failed waiting for it ("Unable
  // to start a transaction in the given time"). A row added or removed between
  // the two reads is put right by the next refresh.
  const [total, rows] = await Promise.all([
    prisma.bid.count({ where }),
    prisma.bid.findMany({
      where,
      include: bidInclude,
      orderBy: listOrderBy(query.sort),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    items: await mapBids(rows),
    page,
    pageSize,
    total,
    // A filter that matches nothing still has one (empty) page, so a client
    // clamping its page number to `totalPages` never lands on page 0.
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * The Pipeline board's opening state: every stage's count and its first page
 * of cards, most recently touched first.
 *
 * One request rather than eleven — a board that fired a query per column would
 * spend its first second on round trips — and one count query rather than
 * eleven, since `groupBy` answers for every status at once. The per-stage
 * reads are the same query the column's "load more" makes, so page 2 lines up
 * exactly behind what the board opened with.
 */
export async function pipelineBoard(actor: Actor, query: PipelineQuery): Promise<PipelineBoard> {
  const access = bidAccessScope(actor);
  const profile = profileScope(actor, query.profileId);
  const scope: PrismaTypes.BidWhereInput = profile.profileId
    ? { AND: [access, profile] }
    : access;

  const [counts, firstPages] = await Promise.all([
    prisma.bid.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    Promise.all(
      BID_STATUSES.map((status) =>
        prisma.bid.findMany({
          where: { AND: [scope, { status: toDbStatus(status) }] },
          include: bidInclude,
          orderBy: listOrderBy('updatedAt'),
          take: query.pageSize,
        }),
      ),
    ),
  ]);

  const totals = new Map(counts.map((row) => [fromDbStatus(row.status), row._count._all]));

  // Mapped as one list so each candidate photo is signed once across the whole
  // board, then cut back into columns by the lengths that went in.
  const bids = await mapBids(firstPages.flat());
  let offset = 0;
  const stages = BID_STATUSES.map((status, index) => {
    const items = bids.slice(offset, offset + firstPages[index]!.length);
    offset += items.length;
    return { status, total: totals.get(status) ?? 0, items };
  });

  return { pageSize: query.pageSize, stages };
}

export async function getBid(actor: Actor, bidId: string): Promise<Bid> {
  return mapBid(await findRowOrThrow(actor, bidId));
}

/**
 * The account a new application is filed under.
 *
 * An admin picks the profile on the form, which is the whole point of them
 * filing one; anyone else gets their own account whatever the payload says, so
 * a hand-written `userId` cannot plant an application in someone else's list.
 */
async function resolveOwner(actor: Actor, requested: string | undefined): Promise<string> {
  if (!requested || !isAdmin(actor)) return actor.id;

  const target = await prisma.user.findUnique({ where: { id: requested }, select: { id: true } });
  if (!target) throw new NotFoundError('No such account to file this application under.');
  return target.id;
}

/**
 * Resolve the application Profile a new bid should belong to, and a User to
 * keep as the technical owner (`Bid.userId` is still required).
 *
 * Preference order for the owning User when the admin did not name one:
 * the Profile's legacy `userId`, then the first shared User, then the admin.
 *
 * A plain User may name a Profile only when it has been shared with them; the
 * bid is then filed under their own account.
 */
async function resolveProfileFiling(
  actor: Actor,
  requestedProfileId: string | undefined,
  requestedUserId: string | undefined,
): Promise<{ userId: string; profileId: string | null }> {
  // A Profile token (the HiringCafe scraper): always its own Profile, filed
  // under the Profile's account, whatever the payload names.
  if (actor.profileId) {
    if (requestedProfileId && requestedProfileId !== actor.profileId) {
      throw new NotFoundError('No such profile to file this application under.');
    }
    return { userId: actor.id, profileId: actor.profileId };
  }

  if (!requestedProfileId) {
    return { userId: await resolveOwner(actor, requestedUserId), profileId: null };
  }

  if (!isAdmin(actor)) {
    const shared = await profilesService.isSharedWith(actor.id, requestedProfileId);
    if (!shared) {
      throw new NotFoundError('No such profile to file this application under.');
    }
    return { userId: actor.id, profileId: requestedProfileId };
  }

  const profile = await prisma.profile.findUnique({
    where: { id: requestedProfileId },
    select: {
      id: true,
      userId: true,
      shares: { select: { userId: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
  });
  if (!profile) throw new NotFoundError('No such profile to file this application under.');

  if (requestedUserId) {
    const target = await prisma.user.findUnique({
      where: { id: requestedUserId },
      select: { id: true },
    });
    if (!target) throw new NotFoundError('No such account to file this application under.');
    return { userId: requestedUserId, profileId: profile.id };
  }

  const userId = profile.userId ?? profile.shares[0]?.userId ?? actor.id;
  return { userId, profileId: profile.id };
}

/**
 * Refuses an application the profile already has.
 *
 * Two rules, checked in this order so the more specific one is reported:
 *
 * 1. **The same posting** — the same job link, ignoring a #fragment, utm_*
 *    parameters, a trailing slash and case (`jobUrlKey`).
 * 2. **The same employer** — any application at the same company, however its
 *    name was written ("Acme" = "Acme, Inc."; `companyKey`). Expired and
 *    Other applications do not count: that company is open to apply to again.
 *
 * Per filing scope: the application Profile when there is one, otherwise the
 * owner's legacy rows. Two candidates may apply to the same company; one
 * candidate may not apply there twice.
 *
 * Runs inside the caller's transaction after taking a lock on that scope, so
 * two saves arriving together (the scraper extension saving several tabs)
 * cannot both pass the check before either is written.
 */
/** Statuses that leave their company free for another application. */
const COMPANY_OPEN_STATUSES: ReadonlySet<string> = new Set(['EXPIRED', 'OTHER']);

async function assertNotDuplicate(
  tx: PrismaTypes.TransactionClient,
  scope: BidScope,
  /** `company` undefined skips the employer rule (an edit that kept the company). */
  candidate: { company?: string; jobUrl?: string | null },
  excludeId?: string,
): Promise<void> {
  const scopeWhere = bidScopeWhere(scope);
  await lockBidScope(tx, scope);

  const rows = await tx.bid.findMany({
    where: { AND: [scopeWhere, ...(excludeId ? [{ id: { not: excludeId } }] : [])] },
    select: { id: true, company: true, role: true, status: true, bidDate: true, jobUrl: true },
    orderBy: { bidDate: 'desc' },
  });
  const describe = (row: (typeof rows)[number]) => ({
    id: row.id,
    company: row.company,
    role: row.role,
    status: fromDbStatus(row.status),
    bidDate: formatDateOnly(row.bidDate),
  });

  const urlKey = candidate.jobUrl ? jobUrlKey(candidate.jobUrl) : '';
  if (urlKey) {
    const sameUrl = rows.filter((row) => row.jobUrl && jobUrlKey(row.jobUrl) === urlKey);
    if (sameUrl.length) {
      const first = sameUrl[0]!;
      throw new DuplicateApplicationError(
        `This job is already an application: ${first.company} — ${first.role}.`,
        'job-url',
        sameUrl.map(describe),
      );
    }
  }

  if (candidate.company === undefined) return;
  const key = companyKey(candidate.company);
  // An Expired or Other application does not hold the employer: it closed
  // without an application of the candidate's own, so another role there is
  // fair game. The same posting is still refused by the link rule above.
  const sameCompany = rows.filter(
    (row) => !COMPANY_OPEN_STATUSES.has(row.status) && companyKey(row.company) === key,
  );
  if (sameCompany.length) {
    const first = sameCompany[0]!;
    throw new DuplicateApplicationError(
      `This profile already has an application at ${first.company} (${first.role}).`,
      'company',
      sameCompany.map(describe),
    );
  }
}

export async function createBid(actor: Actor, input: CreateBidInput): Promise<Bid> {
  const interviews = dedupeByStage(input.interviews ?? []);

  const { userId, profileId } = await resolveProfileFiling(actor, input.profileId, input.userId);

  const row = await prisma.$transaction(async (tx) => {
    await assertNotDuplicate(tx, { userId, profileId }, input);
    const number = await nextBidNumber(tx, { userId, profileId });
    return tx.bid.create({
    data: {
      userId,
      profileId,
      number,
      company: input.company,
      role: input.role,
      jobUrl: input.jobUrl ?? null,
      location: input.location,
      jobDescription: input.jobDescription ?? null,
      postedAt: parsePostedAt(input.postedAt),
      rateType: input.rateType ? toDbRateType(input.rateType) : null,
      rateAmount: input.rateAmount ?? null,
      bidDate: parseDateOnly(input.bidDate),
      status: toDbStatus(input.status),
      appliedAt: appliedAtFor(input.status, null),
      followUpDate: input.followUpDate ? parseDateOnly(input.followUpDate) : null,
      resumeVersion: input.resumeVersion ?? null,
      notes: input.notes ?? null,
      resumeDocument: input.resumeDocument ?? PrismaTypes.DbNull,
      resumeMadeAt: input.resumeDocument ? new Date() : null,
      coverLetterDocument: input.coverLetterDocument ?? PrismaTypes.DbNull,
      applicationChat: input.applicationChat?.length
        ? input.applicationChat
        : PrismaTypes.DbNull,
      interviews: { create: toInterviewCreateData(interviews) },
      ...(input.commitmentDetails
        ? { commitment: { create: toCommitmentData(input.commitmentDetails) } }
        : {}),
    },
    include: bidInclude,
    });
  });

  return mapBid(row);
}

export async function updateBid(
  actor: Actor,
  bidId: string,
  input: UpdateBidInput,
): Promise<Bid> {
  const existing = await findRowOrThrow(actor, bidId);
  const current = toApiBid(existing);

  const nextStatus = input.status ?? current.status;
  const nextInterviews = input.interviews
    ? dedupeByStage(input.interviews)
    : current.interviews ?? [];


  const row = await prisma.$transaction(async (tx) => {
    // Renaming the company or changing the link must not turn this into a
    // second application at an employer — or for a posting — the profile has.
    const nextCompany = input.company ?? existing.company;
    const nextJobUrl = 'jobUrl' in input ? (input.jobUrl ?? null) : existing.jobUrl;
    const companyChanged = companyKey(nextCompany) !== companyKey(existing.company);
    const jobUrlChanged =
      jobUrlKey(nextJobUrl ?? '') !== jobUrlKey(existing.jobUrl ?? '') && !!nextJobUrl;
    if (companyChanged || jobUrlChanged) {
      await assertNotDuplicate(
        tx,
        { userId: existing.userId, profileId: existing.profileId },
        {
          company: companyChanged ? nextCompany : undefined,
          jobUrl: jobUrlChanged ? nextJobUrl : null,
        },
        bidId,
      );
    }

    if (input.interviews) {
      // Replace wholesale: the payload is the complete intended set, matching
      // the object-spread semantics the frontend's storage layer had.
      await tx.interviewRound.deleteMany({ where: { bidId } });
      await tx.interviewRound.createMany({
        data: toInterviewCreateData(nextInterviews).map((round) => ({ ...round, bidId })),
      });
    }

    if (input.commitmentDetails === null) {
      await tx.commitment.deleteMany({ where: { bidId } });
    } else if (input.commitmentDetails !== undefined) {
      const data = toCommitmentData(input.commitmentDetails);
      await tx.commitment.upsert({
        where: { bidId },
        create: { bidId, ...data },
        update: data,
      });
    }

    const data = toScalarData(input);
    if (input.status !== undefined) data.appliedAt = appliedAtFor(nextStatus, existing.appliedAt);
    if ('resumeDocument' in input) {
      // A Resume stored now counts today unless one was already there; taking
      // the document away clears it unless synced files are still the Resume.
      data.resumeMadeAt = input.resumeDocument
        ? (existing.resumeMadeAt ?? new Date())
        : existing.resumeFiles.length > 0 || existing.resumeAnswer !== null || existing.resumeKept
          ? existing.resumeMadeAt
          : null;
    }

    return tx.bid.update({
      where: { id: bidId },
      data,
      include: bidInclude,
    });
  });

  // The Resume folder's copies follow the new status (Skip… none; Draft built again).
  if (input.status !== undefined && input.status !== current.status) filesFollowStatus([bidId], toDbStatus(nextStatus));

  return mapBid(row);
}

/**
 * The Resume stored against a bid, or null when none was ever generated for it.
 *
 * Read separately rather than mapped onto every bid: the list endpoint carries
 * only a `hasResume` flag, so this is the one place the document itself is
 * loaded, and only for the row being downloaded.
 */
export async function getBidResume(actor: Actor, bidId: string): Promise<unknown | null> {
  const row = await prisma.bid.findFirst({
    where: { id: bidId, ...bidAccessScope(actor) },
    select: { resumeDocument: true },
  });

  if (!row) throw new NotFoundError('Application not found.');
  return row.resumeDocument ?? null;
}

/**
 * The cover letter stored against a bid, or null when none was written for it.
 *
 * Loaded on its own for the same reason the Resume is: the list endpoint
 * carries a `hasCoverLetter` flag, so the letter itself is read only for the
 * one application being downloaded.
 */
export async function getBidCoverLetter(actor: Actor, bidId: string): Promise<unknown | null> {
  const row = await prisma.bid.findFirst({
    where: { id: bidId, ...bidAccessScope(actor) },
    select: { coverLetterDocument: true },
  });

  if (!row) throw new NotFoundError('Application not found.');
  return row.coverLetterDocument ?? null;
}

/**
 * Stores a cover letter on an application without touching anything else on
 * it — what "Make" in the Applications table does after ChatGPT writes one.
 * Ownership is the same as any other write to the bid.
 */
export async function setBidCoverLetter(actor: Actor, bidId: string, document: object): Promise<Bid> {
  const existing = await findRowOrThrow(actor, bidId);
  await prisma.bid.update({
    where: { id: existing.id },
    data: { coverLetterDocument: document as PrismaTypes.InputJsonValue },
  });
  return getBid(actor, existing.id);
}

/**
 * The conversation stored against a bid.
 *
 * Loaded on its own for the same reason the Resume is: the list endpoint
 * carries a count, so the transcript is read only for the application actually
 * being looked at. An application that had no conversation answers with an
 * empty list rather than a 404 — "nothing was asked" is a fact about it, not a
 * missing resource.
 */
export async function getBidChat(actor: Actor, bidId: string): Promise<ChatMessage[]> {
  const row = await prisma.bid.findFirst({
    where: { id: bidId, ...bidAccessScope(actor) },
    select: { applicationChat: true },
  });

  if (!row) throw new NotFoundError('Application not found.');

  // Parsed rather than trusted: it is a JSON column, so what is in it is
  // whatever an older shape of this feature wrote. Anything that does not read
  // as a transcript is reported as none, which is what the screen can actually
  // do something about.
  const parsed = ChatTranscriptSchema.safeParse(row.applicationChat ?? []);
  return parsed.success ? parsed.data : [];
}

/** One file the folder sync sends up: what the desktop Resume Builder wrote. */
export interface ResumeFileUpload {
  format: ResumeFileFormat;
  name: string;
  contentType: string;
  data: Buffer;
}

/**
 * Stores the Resume files synced up from the application's folder, one row per
 * format, replacing a file of the same format in place. The hash is computed
 * here rather than trusted from the client: it is what the next sync compares
 * the file on disk against, so it has to describe the bytes actually stored.
 *
 * Ownership is the same as any other write to the bid — a candidate syncs
 * their own, an admin anyone's. A sync of only the PDF leaves the Word file
 * as it was; the sync sends what changed.
 */
export async function replaceResumeFiles(
  actor: Actor,
  bidId: string,
  files: ResumeFileUpload[],
): Promise<Bid> {
  const existing = await findRowOrThrow(actor, bidId);
  if (files.length === 0) throw new BadRequestError('No Resume file was uploaded. Send `pdf` and/or `docx`.');

  await prisma.$transaction(async (tx) => {
    for (const file of files) {
      const sha256 = createHash('sha256').update(file.data).digest('hex');
      const stored = {
        name: file.name.slice(0, 255),
        contentType: file.contentType,
        size: file.data.byteLength,
        sha256,
        data: new Uint8Array(file.data),
      };
      await tx.bidResumeFile.upsert({
        where: { bidId_format: { bidId: existing.id, format: file.format } },
        create: { bidId: existing.id, format: file.format, ...stored },
        update: stored,
      });
    }
    // The Resume changed, so the application did: the version poll must see it.
    await tx.bid.update({
      where: { id: existing.id },
      data: { updatedAt: new Date(), ...(existing.resumeMadeAt ? {} : { resumeMadeAt: new Date() }) },
    });
    // Two files of ~100 KB each over a remote pooler can take more than
    // Prisma's default 5s; past it the whole save was thrown away.
  }, { timeout: 30_000, maxWait: 10_000 });

  return getBid(actor, existing.id);
}

/**
 * The bytes of one synced Resume file, or `null` when none of that format was
 * synced — the caller then falls back to rendering the stored document, if
 * there is one. Access-checked as every bid read is.
 */
export async function getResumeFile(
  actor: Actor,
  bidId: string,
  format: ResumeFileFormat,
): Promise<{ name: string; contentType: string; data: Buffer } | null> {
  const file = await prisma.bidResumeFile.findFirst({
    where: { format, bid: { id: bidId, ...bidAccessScope(actor) } },
    select: { name: true, contentType: true, data: true },
  });
  if (!file) return null;
  return { name: file.name, contentType: file.contentType, data: Buffer.from(file.data) };
}

/**
 * Removes every synced Resume file from an application — what the folder
 * sync does when the files it synced earlier are gone from the folder. The
 * generated document, if any, is untouched: it was never the folder's.
 */
export async function removeResumeFiles(actor: Actor, bidId: string): Promise<Bid> {
  const existing = await findRowOrThrow(actor, bidId);
  await prisma.$transaction([
    prisma.bidResumeFile.deleteMany({ where: { bidId: existing.id } }),
    prisma.bid.update({
      where: { id: existing.id },
      // With no generated document behind them, the files were the Resume.
      data: { updatedAt: new Date(), ...(existing.resumeDocument === null ? { resumeMadeAt: null } : {}) },
    }),
  ]);
  return getBid(actor, existing.id);
}

/**
 * Earlier automatic-make failures on an application, forgotten, so a Resume
 * or letter just deleted is made again at once rather than after a back-off.
 * A worker holding it right now keeps its hold.
 */
function forgetAutoMakeFailures(bidId: string) {
  return prisma.autoMakeClaim.deleteMany({ where: { bidId, claimedAt: null } });
}

/**
 * Deletes an application's Resume — the stored files and the generated
 * document both — for one that came out wrong. It goes back to "No resume",
 * so the automatic maker makes it (and its cover letter) again. The cover
 * letter is left until then.
 */
export async function deleteResume(actor: Actor, bidId: string): Promise<Bid> {
  const existing = await findRowOrThrow(actor, bidId);
  await prisma.$transaction([
    prisma.bidResumeFile.deleteMany({ where: { bidId: existing.id } }),
    prisma.bid.update({
      where: { id: existing.id },
      data: {
        resumeDocument: PrismaTypes.DbNull,
        resumeAnswer: PrismaTypes.DbNull,
        resumeBuild: PrismaTypes.DbNull,
        resumeKept: false,
        resumeMadeAt: null,
        updatedAt: new Date(),
        // Its check went with it.
        resumeCheckStatus: null,
        resumeCheckReasons: [],
        resumeCheckedAt: null,
        resumeTextHash: null,
      },
    }),
    forgetAutoMakeFailures(existing.id),
  ]);
  // Its files in the Resume folder go with it.
  await dropCopiesQuietly([existing.id], 'resume');
  if (existing.resumeKept) await dropKept(existing.id).catch((error) => logger.warn({ err: error, bidId }, 'Could not delete a kept Resume'));
  return getBid(actor, existing.id);
}

/**
 * Deletes an application's cover letter, for one that came out wrong. With
 * its Resume still stored, the automatic maker writes the letter again.
 */
export async function deleteCoverLetter(actor: Actor, bidId: string): Promise<Bid> {
  const existing = await findRowOrThrow(actor, bidId);
  await prisma.$transaction([
    prisma.bid.update({
      where: { id: existing.id },
      data: { coverLetterDocument: PrismaTypes.DbNull, updatedAt: new Date() },
    }),
    forgetAutoMakeFailures(existing.id),
  ]);
  await dropCopiesQuietly([existing.id], 'cover-letter');
  return getBid(actor, existing.id);
}

/**
 * The proof screenshot — the job site's confirmation page — uploaded against
 * one application, replacing whatever was there. Refused with 409 when it is
 * the same picture as one already on another of the profile's applications.
 *
 * The bucket is written first and the row second, so a failed upload leaves
 * the old screenshot in place rather than a bid pointing at nothing. The
 * object the row used to name is deleted afterwards and its failure is
 * swallowed: an orphan in a bucket is cheaper than a 500 on a save that
 * already succeeded. Ownership is the same as any other write to the bid — a
 * candidate replaces their own, an admin anyone's.
 */
export async function replaceProof(
  actor: Actor,
  bidId: string,
  body: Buffer,
  contentType: string,
): Promise<Bid> {
  const existing = await findRowOrThrow(actor, bidId);

  // Fingerprinted before anything is written: a file that is not a picture
  // is refused here, and refused before the bucket has been touched.
  let fingerprint: ProofFingerprint;
  try {
    fingerprint = await fingerprintImage(body);
  } catch (error) {
    logger.info({ err: error, bidId }, 'proof screenshot could not be decoded');
    throw new BadRequestError('That file could not be read as an image. Upload the screenshot itself.');
  }

  // And compared before anything is written, for the same reason: a picture
  // already on another of the profile's applications is not stored on this
  // one. Every application has its own confirmation page or none.
  const duplicates = await findProofMatches(existing.id, existing.userId, fingerprint);
  if (duplicates.length > 0) {
    throw new DuplicateProofError(
      'That screenshot is already on another of your applications. Each application needs its own confirmation page.',
      duplicates,
    );
  }

  const { key } = await uploadProof(bidId, body, contentType);

  const row = await prisma.bid.update({
    where: { id: existing.id },
    data: { proofKey: key, proofFingerprint: { ...fingerprint } },
    include: bidInclude,
  });

  await deletePhoto(existing.proofKey);

  return mapBid(row);
}

/**
 * The check the form runs the moment a screenshot is picked, pasted or
 * dropped — before there is an application to store it on. The same
 * comparison the upload makes, with nothing written and nothing kept.
 *
 * Whose screenshots it is compared with: the application's owner when one is
 * being edited (`bidId`, which is also left out of the comparison, being the
 * one the screenshot is for); otherwise the candidate an admin is filing for
 * (`userId`); otherwise the caller. A plain account cannot name another
 * profile — `userId` is ignored for anyone but an admin.
 */
export async function checkProof(
  actor: Actor,
  body: Buffer,
  scope: { bidId?: string; userId?: string },
): Promise<ProofMatch[]> {
  let fingerprint: ProofFingerprint;
  try {
    fingerprint = await fingerprintImage(body);
  } catch (error) {
    logger.info({ err: error }, 'proof screenshot could not be decoded');
    throw new BadRequestError('That file could not be read as an image. Upload the screenshot itself.');
  }

  let ownerId = actor.id;
  if (scope.bidId) ownerId = (await findRowOrThrow(actor, scope.bidId)).userId;
  else if (scope.userId && isAdmin(actor)) ownerId = scope.userId;

  return findProofMatches(scope.bidId ?? null, ownerId, fingerprint);
}

/**
 * The same profile's other applications whose screenshot is the same picture
 * as this one's. An upload that would create such a pair is refused, so this
 * finds only what was there before the rule — screenshots uploaded before
 * fingerprints existed and since backfilled — for the details view, where an
 * admin can see it and have one replaced. Answered from the stored
 * fingerprints, so no screenshot is fetched. An application with no
 * fingerprint has no matches.
 */
export async function proofMatches(actor: Actor, bidId: string): Promise<ProofMatch[]> {
  const row = await findRowOrThrow(actor, bidId);
  const fingerprint = parseFingerprint(row.proofFingerprint);
  if (!fingerprint) return [];
  return findProofMatches(row.id, row.userId, fingerprint);
}

/**
 * The comparison itself, against the *same profile's* other applications —
 * the profile the bid belongs to, which is the candidate's own on their
 * upload and the chosen candidate's on an admin's. One person filing the
 * same confirmation page twice is what is looked for; another profile's
 * screenshots are not compared. Closest first.
 *
 * Fingerprints are small (about a kilobyte) and the comparison is arithmetic,
 * so every one of the profile's is read and compared in memory.
 */
async function findProofMatches(bidId: string | null, ownerId: string, fingerprint: ProofFingerprint): Promise<ProofMatch[]> {
  const candidates = await prisma.bid.findMany({
    where: {
      ...(bidId ? { id: { not: bidId } } : {}),
      userId: ownerId,
      proofFingerprint: { not: PrismaTypes.DbNull },
    },
    select: { id: true, proofFingerprint: true },
  });

  const hits = candidates
    .flatMap((candidate) => {
      const other = parseFingerprint(candidate.proofFingerprint);
      if (!other) return [];
      const distance = fingerprintDistance(fingerprint, other);
      return isSameScreenshot(distance) ? [{ id: candidate.id, distance }] : [];
    })
    // The same picture first, then whatever differs least.
    .sort((a, b) => Number(b.distance.identical) - Number(a.distance.identical) || a.distance.difference - b.distance.difference);
  if (hits.length === 0) return [];

  const rows = await prisma.bid.findMany({ where: { id: { in: hits.map((hit) => hit.id) } }, include: bidInclude });
  const bids = new Map((await mapBids(rows)).map((bid) => [bid.id, bid]));

  return hits.flatMap((hit) => {
    const bid = bids.get(hit.id);
    return bid ? [{ match: { identical: hit.distance.identical, difference: round(hit.distance.difference) }, bid }] : [];
  });
}

/** Three decimals is what a screen can show and a test can assert. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Removes the proof. Admin-only at the route: the screenshot is what a
 * candidate is checked against, so it is not theirs to take back — they may
 * replace it with a better one, which is the only reason to.
 */
export async function removeProof(actor: Actor, bidId: string): Promise<Bid> {
  const existing = await findRowOrThrow(actor, bidId);

  const row = await prisma.bid.update({
    where: { id: existing.id },
    data: { proofKey: null, proofFingerprint: PrismaTypes.DbNull },
    include: bidInclude,
  });

  await deletePhoto(existing.proofKey);

  return mapBid(row);
}

/**
 * Admin-only; the route enforces that before this is reached.
 *
 * The proof screenshot goes with it, best-effort: the row is gone first, and
 * a failed bucket delete is an orphan rather than an error.
 */
export async function deleteBid(actor: Actor, bidId: string): Promise<void> {
  const existing = await prisma.bid.findFirst({
    where: { id: bidId, ...bidAccessScope(actor) },
    select: { proofKey: true },
  });
  const { count } = await prisma.bid.deleteMany({ where: { id: bidId, ...bidAccessScope(actor) } });
  if (count === 0) throw new NotFoundError('Bid not found.');

  await deletePhoto(existing?.proofKey);
  // Its files in the Resume folder (and a kept old Resume) go too.
  await dropCopiesQuietly([bidId]);
  await dropKept(bidId).catch((error) => logger.warn({ err: error, bidId }, 'Could not delete a kept Resume'));
}

/**
 * The bulk status change behind the Applications page's multi-select. Moving a
 * selection into an interview stage applies one shared date and time to every
 * bid, which is what the frontend's bulk-schedule dialog collects.
 */
export async function bulkUpdateStatus(
  actor: Actor,
  input: BulkStatusInput,
): Promise<{ updated: number }> {
  const owned = await prisma.bid.findMany({
    where: { id: { in: input.ids }, ...bidAccessScope(actor) },
    select: { id: true },
  });
  if (owned.length === 0) return { updated: 0 };

  const ownedIds = owned.map((bid) => bid.id);
  const stage = toDbStatus(input.status);

  await prisma.$transaction(async (tx) => {
    if (input.interviewDateTime) {
      const dateTime = parseNaiveDateTime(input.interviewDateTime);
      // Overwrite any existing round for this stage rather than duplicating it.
      await tx.interviewRound.deleteMany({ where: { bidId: { in: ownedIds }, stage } });
      await tx.interviewRound.createMany({
        data: ownedIds.map((bidId) => ({ bidId, stage, dateTime })),
      });
    }

    const unsent = input.status === 'Draft' || input.status === 'Skip';
    await tx.bid.updateMany({
      where: { id: { in: ownedIds } },
      data: { status: stage, updatedAt: new Date(), ...(unsent ? { appliedAt: null } : {}) },
    });
    // Sent for the first time: stamped now. See `appliedAtFor`.
    if (!unsent && input.status !== 'Expired') {
      await tx.bid.updateMany({
        where: { id: { in: ownedIds }, appliedAt: null },
        data: { appliedAt: new Date() },
      });
    }
  });

  // The Resume folder's copies follow the new status.
  filesFollowStatus(ownedIds, stage);

  return { updated: ownedIds.length };
}

export async function bulkDeleteBids(
  actor: Actor,
  input: BulkDeleteInput,
): Promise<{ deleted: number }> {
  const where = { id: { in: input.ids }, ...bidAccessScope(actor) };
  const doomed = await prisma.bid.findMany({ where, select: { id: true, proofKey: true } });
  const { count } = await prisma.bid.deleteMany({ where });

  // Their screenshots too, after the rows: each delete swallows its own failure.
  await Promise.all(doomed.map((row) => deletePhoto(row.proofKey)));
  // And their files in the Resume folder.
  await dropCopiesQuietly(doomed.map((row) => row.id));
  await Promise.all(doomed.map((row) => dropKept(row.id).catch(() => undefined)));

  return { deleted: count };
}
