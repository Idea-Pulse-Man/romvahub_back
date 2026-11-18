import { prisma } from '../prisma.js';
import { logger } from '../logger.js';

/**
 * Expire stale Drafts once a day.
 *
 * At the start of each day (US Eastern, the same calendar `bidDate` uses), a
 * Draft whose posting went up more than a day ago is marked Expired: a job
 * left that long has usually had its applicants, and applying late is wasted
 * work. Only Drafts are touched; anything already applied to, skipped or
 * closed keeps its status, and a Draft with no known posting time is left
 * alone.
 *
 * The check runs once at startup, then every few minutes looks at whether the
 * Eastern date has changed since the last run. That survives DST shifts, a
 * server that slept through midnight, and a restart mid-day, and running it
 * twice is harmless.
 */

const TIME_ZONE = 'America/New_York';
const CHECK_EVERY_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function easternDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Mark every Draft posted more than a day before `now` as Expired. Returns how many. */
export async function expireStaleDrafts(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - MAX_AGE_MS);
  const { count } = await prisma.bid.updateMany({
    where: { status: 'DRAFT', postedAt: { lt: cutoff } },
    data: { status: 'EXPIRED' },
  });
  return count;
}

export function startDraftExpiry(): void {
  let lastRunDate: string | null = null;
  let running = false;

  const tick = async () => {
    const now = new Date();
    const today = easternDate(now);
    if (running || today === lastRunDate) return;
    running = true;
    try {
      const count = await expireStaleDrafts(now);
      lastRunDate = today;
      logger.info({ count, date: today }, 'Expired Drafts posted more than a day ago');
    } catch (err) {
      // Left unset so the next check tries again.
      logger.error({ err }, 'Could not expire stale Drafts');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), CHECK_EVERY_MS);
  timer.unref();
}
