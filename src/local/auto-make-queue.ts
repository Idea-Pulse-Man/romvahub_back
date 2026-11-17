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

/** The applications in `scope` waiting for a Resume, oldest first, not held by anyone and not cooling down. */
async function waiting(scope: PrismaTypes.BidWhereInput, take: number) {
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
          resumeDocument: { equals: PrismaTypes.AnyNull },
          resumeFiles: { none: {} },
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
export async function claimNext(scope: PrismaTypes.BidWhereInput, worker: string): Promise<ClaimedApplication | null> {
  for (const candidate of await waiting(scope, 5)) {
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

/** Whether `bidId` is held right now (by anyone): the job routes refuse a step on an application nobody took. */
export async function isClaimed(bidId: string): Promise<boolean> {
  const row = await prisma.autoMakeClaim.findUnique({ where: { bidId }, select: { claimedAt: true } });
  return !!row?.claimedAt && Date.now() - row.claimedAt.getTime() < CLAIM_TTL_MINUTES * 60_000;
}

/** A step done: the hold is renewed, so a slow ChatGPT does not cost the worker its application. */
export async function touchClaim(bidId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "auto_make_claims" SET "claimedAt" = ${NOW_UTC}, "updatedAt" = ${NOW_UTC}
    WHERE "bidId" = ${bidId}::uuid AND "claimedAt" IS NOT NULL`;
}

/** Finished: the row goes, and with it any record of earlier failures. */
export async function completeClaim(bidId: string): Promise<void> {
  await prisma.autoMakeClaim.deleteMany({ where: { bidId } });
}

/**
 * Handed back. `failed`: the application's own problem (an answer that could
 * not be read…), counted, and it waits before the next try. Otherwise the
 * worker could not get to it (ChatGPT signed out, the window closed): free for
 * the next worker at once, no count.
 */
export async function releaseClaim(bidId: string, outcome: { failed: boolean; error?: string }): Promise<void> {
  const error = outcome.error?.slice(0, 2000) ?? null;
  if (outcome.failed) {
    await prisma.$executeRaw`
      UPDATE "auto_make_claims"
      SET "claimedAt" = NULL, "attempts" = "attempts" + 1, "failedAt" = ${NOW_UTC}, "lastError" = ${error}, "updatedAt" = ${NOW_UTC}
      WHERE "bidId" = ${bidId}::uuid`;
  } else {
    await prisma.$executeRaw`
      UPDATE "auto_make_claims" SET "claimedAt" = NULL, "updatedAt" = ${NOW_UTC}
      WHERE "bidId" = ${bidId}::uuid`;
  }
}
