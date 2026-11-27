import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../../logger.js';
import { prisma } from '../../prisma.js';
import { copyExpired } from './file-rules.js';
import { listCopies, resumeFolder } from './folder.js';

/**
 * The Resume folder's nightly clean-up: applies the status rules
 * (`file-rules.ts`) to every copy in it, and deletes the copies of
 * applications that are gone or whose content went to a backup. Copies are
 * built again from the JSON whenever someone opens one, so deleting one never
 * loses anything. `kept\` is never touched.
 */

const TIME_ZONE = 'America/New_York';
const CHECK_EVERY_MS = 30 * 60 * 1000;
/** Runs once a day, from this hour (Eastern) on: after the 3 AM database backup. */
const RUN_FROM_HOUR = 4;

export async function cleanUpResumeFolder(now = new Date()): Promise<{ applications: number; deleted: number }> {
  const copies = await listCopies();
  const ids = [...copies.keys()];
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const rows = await prisma.bid.findMany({
      where: { id: { in: batch } },
      select: { id: true, status: true, appliedAt: true, backedUpAt: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of batch) {
      const row = byId.get(id);
      const dirs = copies.get(id) ?? [];
      for (const copy of dirs) {
        const gone = !row || row.backedUpAt !== null || copyExpired(row.status, row.appliedAt, copy.modifiedAt, now);
        if (!gone) continue;
        await fs.rm(copy.dir, { recursive: true, force: true });
        deleted += 1;
      }
      // An application folder left empty goes too.
      const appDir = path.join(await resumeFolder(), id);
      try {
        if ((await fs.readdir(appDir)).length === 0) await fs.rmdir(appDir);
      } catch {
        // Already gone.
      }
    }
  }
  return { applications: ids.length, deleted };
}

function easternParts(now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

export function startResumeFolderCleanup(): void {
  let lastRunDate: string | null = null;
  let running = false;

  const tick = async () => {
    const now = new Date();
    const { date, hour } = easternParts(now);
    if (running || date === lastRunDate || hour < RUN_FROM_HOUR) return;
    running = true;
    try {
      const result = await cleanUpResumeFolder(now);
      lastRunDate = date;
      logger.info({ ...result, date }, 'Resume folder: nightly clean-up done');
    } catch (err) {
      // Left unset so the next check tries again.
      logger.error({ err }, 'Resume folder: nightly clean-up failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), CHECK_EVERY_MS);
  timer.unref();
  void tick();
}
