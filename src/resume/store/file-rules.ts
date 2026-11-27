import type { BidStatus } from '../../generated/prisma/client.js';
import { logger } from '../../logger.js';
import { dropCopiesQuietly } from './folder.js';
import { makeCopies } from './resume-store.js';

/**
 * Which applications keep their Word and PDF copies in the Resume folder. The
 * JSON always stays in the database; only the copies follow these rules.
 *
 *   Draft, Screening … Completed   kept
 *   Applied                        kept for 20 days after it was applied
 *   Skip, Failed, Expired, Other   none (JSON only)
 *
 * A copy made later for one that keeps none — someone opened it, or "Make
 * files" — is deleted 3 days after it was made. The nightly clean-up
 * (`cleanup.ts`) applies the rules; a status change applies them at once.
 */

export const KEEP_STATUSES: ReadonlySet<BidStatus> = new Set<BidStatus>([
  'DRAFT',
  'SCREENING_ROUND_1',
  'INTERVIEW_ROUND_2',
  'INTERVIEW_ROUND_3',
  'FINAL_INTERVIEW',
  'OFFER',
  'BACKGROUND_CHECK_PASSED',
  'STARTED',
  'COMPLETED',
]);

export const JSON_ONLY_STATUSES: ReadonlySet<BidStatus> = new Set<BidStatus>(['SKIP', 'FAILED', 'EXPIRED', 'OTHER']);

/** Applied: the copies stay this many days after the application was sent. */
export const APPLIED_KEEP_DAYS = 20;
/** A copy made for one that keeps none: deleted this many days after it was made. */
export const MADE_LATER_KEEP_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether an application keeps copies now (true), or only for `MADE_LATER_KEEP_DAYS` after they are made. */
export function keepsCopies(status: BidStatus, appliedAt: Date | null, now = new Date()): boolean {
  if (KEEP_STATUSES.has(status)) return true;
  if (status === 'APPLIED') return appliedAt !== null && now.getTime() - appliedAt.getTime() < APPLIED_KEEP_DAYS * DAY_MS;
  return false;
}

/** Whether a copy folder last written at `modifiedAt` goes, for an application in this state. */
export function copyExpired(
  status: BidStatus,
  appliedAt: Date | null,
  modifiedAt: number,
  now = new Date(),
): boolean {
  if (keepsCopies(status, appliedAt, now)) return false;
  return now.getTime() - modifiedAt >= MADE_LATER_KEEP_DAYS * DAY_MS;
}

/** Work done one at a time in the background (building copies), so the server is never flooded. */
let chain: Promise<void> = Promise.resolve();
export function inBackground(label: string, work: () => Promise<unknown>): void {
  chain = chain.then(() =>
    work().then(
      () => undefined,
      (error) => logger.warn({ err: error, label }, 'Resume folder: background work failed'),
    ),
  );
}

/**
 * A status change, applied at once: to Skip, Failed, Expired or Other the
 * copies go; back to Draft they are built again from the JSON.
 */
export function filesFollowStatus(bidIds: string[], status: BidStatus): void {
  if (bidIds.length === 0) return;
  if (JSON_ONLY_STATUSES.has(status)) {
    void dropCopiesQuietly(bidIds);
  } else if (status === 'DRAFT') {
    for (const bidId of bidIds) inBackground(`copies ${bidId}`, () => makeCopies(bidId));
  }
}
