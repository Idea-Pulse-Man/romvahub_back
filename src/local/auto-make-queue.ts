import { Prisma as PrismaTypes } from '../generated/prisma/client.js';
import { prisma } from '../prisma.js';

/**
 * The automatic Resume maker's queue, shared by every worker on every
 * computer (the local API's watcher, the Chrome extension, the desktop agent).
 *
 * Waiting: a Draft application from the last few days with a job description
 * and no Resume. Taking one is atomic (`claim`): one worker per application,
 * and a worker that went quiet for CLAIM_TTL loses it to the next. A failed
 * attempt is counted and the application waits — 5 minutes, or an hour after
 * three misses — on every computer alike.
 *
 * Times are written by the database itself, in UTC, as Prisma stores them.
 */

/** How long a worker may hold an application without moving it on a step. */
const CLAIM_TTL_MINUTES = 15;
/** Only applications added in this window: a fresh start does not make the whole history. */
const LOOKBACK_DAYS = Number(process.env.CHATGPT_AUTO_MAKE_DAYS) || 7;

const NOW_UTC = PrismaTypes.sql`(now() at time zone 'utc')`;

/**
 * The applications in `scope` waiting, oldest first, not held by anyone and
 * not cooling down: for a Resume (and its letter), or — `letterOnly` — for
 * just the cover letter, when the Resume is stored but its letter failed.
 */
async function waiting(scope: PrismaTypes.BidWhereInput, take: number, letterOnly = false) {
  const now = Date.now();
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);
  return prisma.bid.findMany({
    where: {
      AND: [
        scope,
        {
          status: 'DRAFT',
          createdAt: { gte: new Date(now - LOOKBACK_DAYS * 24 * 60 * 60_000) },
          jobDescription: { not: null },
          NOT: [{ jobDescription: '' }],
          ...(letterOnly
            ? { resumeFiles: { some: {} }, coverLetterDocument: { equals: PrismaTypes.AnyNull } }
            : { resumeDocument: { equals: PrismaTypes.AnyNull }, resumeFiles: { none: {} } }),
          OR: [
            { autoMakeClaim: null },
            {
              autoMakeClaim: {
                AND: [
                  { OR: [{ claimedAt: null }, { claimedAt: { lt: minutesAgo(CLAIM_TTL_MINUTES) } }] },
                  {
                    OR: [
                      { failedAt: null },
                      { attempts: { lt: 3 }, failedAt: { lt: minutesAgo(5) } },
                      { failedAt: { lt: minutesAgo(60) } },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take,
    select: { id: true, number: true, company: true, userId: true, user: { select: { role: true } } },
  });
}

export type ClaimedApplication = Awaited<ReturnType<typeof waiting>>[number];

/**
 * Takes the oldest waiting application in `scope` for `worker`, or returns
 * null when there is none. Two workers asking at once never get the same one:
 * the row is written only when it is free (or its holder went quiet).
 */
export async function claimNext(
  scope: PrismaTypes.BidWhereInput,
  worker: string,
  { letterOnly = false }: { letterOnly?: boolean } = {},
): Promise<ClaimedApplication | null> {
  for (const candidate of await waiting(scope, 5, letterOnly)) {
    const taken = await prisma.$queryRaw<{ bidId: string }[]>`
      INSERT INTO "auto_make_claims" ("bidId", "worker", "claimedAt", "updatedAt")
      VALUES (${candidate.id}::uuid, ${worker}, ${NOW_UTC}, ${NOW_UTC})
      ON CONFLICT ("bidId") DO UPDATE
        SET "worker" = EXCLUDED."worker", "claimedAt" = EXCLUDED."claimedAt", "updatedAt" = EXCLUDED."updatedAt"
        WHERE "auto_make_claims"."claimedAt" IS NULL
           OR "auto_make_claims"."claimedAt" < ${NOW_UTC} - make_interval(mins => ${CLAIM_TTL_MINUTES})
      RETURNING "bidId"`;
    if (taken.length > 0) return candidate;
  }
  return null;
}

/** Only the rows `worker` holds; no condition when the caller did not say who it is (older workers). */
function heldBy(worker: string | undefined) {
  return worker ? PrismaTypes.sql`AND "worker" = ${worker}` : PrismaTypes.empty;
}

/**
 * Whether `bidId` is held right now — by `worker` when given, else by anyone:
 * the job routes refuse a step on an application nobody (or someone else) holds.
 */
export async function isClaimed(bidId: string, worker?: string): Promise<boolean> {
  const row = await prisma.autoMakeClaim.findUnique({ where: { bidId }, select: { claimedAt: true, worker: true } });
  if (!row?.claimedAt || Date.now() - row.claimedAt.getTime() >= CLAIM_TTL_MINUTES * 60_000) return false;
  return !worker || row.worker === worker;
}

/**
 * A step done, or a worker still busy on it: the hold is renewed, so a slow
 * ChatGPT does not cost the worker its application. False when the hold had
 * already run out or is someone else's.
 */
export async function touchClaim(bidId: string, worker?: string): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "auto_make_claims" SET "claimedAt" = ${NOW_UTC}, "updatedAt" = ${NOW_UTC}
    WHERE "bidId" = ${bidId}::uuid AND "claimedAt" IS NOT NULL
      AND "claimedAt" >= ${NOW_UTC} - make_interval(mins => ${CLAIM_TTL_MINUTES}) ${heldBy(worker)}`;
  return updated > 0;
}

/** Finished: the row goes, and with it any record of earlier failures. */
export async function completeClaim(bidId: string): Promise<void> {
  await prisma.autoMakeClaim.deleteMany({ where: { bidId } });
}

/**
 * Handed back. `failed`: the application's own problem (an answer that could
 * not be read…), counted, and it waits before the next try. Otherwise the
 * worker could not get to it (ChatGPT signed out, the window closed): free for
 * the next worker at once, no count. With `worker`, only that worker's own
 * hold is handed back: one that lost the application to another worker
 * (its hold ran out) leaves the new holder alone.
 */
export async function releaseClaim(
  bidId: string,
  outcome: { failed: boolean; error?: string },
  worker?: string,
): Promise<void> {
  const error = outcome.error?.slice(0, 2000) ?? null;
  if (outcome.failed) {
    await prisma.$executeRaw`
      UPDATE "auto_make_claims"
      SET "claimedAt" = NULL, "attempts" = "attempts" + 1, "failedAt" = ${NOW_UTC}, "lastError" = ${error}, "updatedAt" = ${NOW_UTC}
      WHERE "bidId" = ${bidId}::uuid ${heldBy(worker)}`;
  } else {
    await prisma.$executeRaw`
      UPDATE "auto_make_claims" SET "claimedAt" = NULL, "updatedAt" = ${NOW_UTC}
      WHERE "bidId" = ${bidId}::uuid ${heldBy(worker)}`;
  }
}

/**
 * Everything `worker` holds among the applications in `scope`, handed back
 * uncounted — for a desktop agent or extension that has just started, whose
 * previous run stopped mid-application, so its work need not wait out CLAIM_TTL.
 */
export async function releaseHeldBy(scope: PrismaTypes.BidWhereInput, worker: string): Promise<number> {
  const { count } = await prisma.autoMakeClaim.updateMany({
    where: { worker, claimedAt: { not: null }, bid: scope },
    data: { claimedAt: null },
  });
  return count;
}

/**
 * Everything `worker` was holding, handed back uncounted — for a worker that
 * has just started, whose previous run was stopped mid-application (a
 * restart), so its applications need not wait out CLAIM_TTL.
 */
export async function releaseAllHeldBy(worker: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "auto_make_claims" SET "claimedAt" = NULL, "updatedAt" = ${NOW_UTC}
    WHERE ("worker" = ${worker} OR "worker" = 'local-api') AND "claimedAt" IS NOT NULL`;
}

/**
 * Start pressed: every application that failed earlier is tried again now,
 * not after its back-off — a Draft without a Resume gets one (and its cover
 * letter), a stored Resume without a letter gets the letter. Applications a
 * worker holds right now are left to it.
 */
export async function retryAllNow(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "auto_make_claims" SET "attempts" = 0, "failedAt" = NULL, "lastError" = NULL, "updatedAt" = ${NOW_UTC}
    WHERE "claimedAt" IS NULL AND ("failedAt" IS NOT NULL OR "attempts" > 0)`;
}
