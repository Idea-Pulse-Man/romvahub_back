import type { Actor } from '../auth/actor.js';
import { ServiceUnavailableError } from '../http/errors.js';
import { logger } from '../logger.js';
import { prisma } from '../prisma.js';
import { Prisma as PrismaTypes } from '../generated/prisma/client.js';
import { makeResumeWithChatGpt, makingNow } from './chatgpt-resume.js';
import { chatGptReady } from './chatgpt-web.js';
import { autoMakeEnabled, reportWorker } from './auto-make-state.js';

/**
 * Automatic Make for applications added *anywhere*, not only through this API.
 *
 * `autoMakeNewApplication` runs inside the request that files the application —
 * which is the deployed API when the job scraper posts to romva.space, and that
 * server has no Chrome to drive. This watcher runs in the API on the computer
 * that does: every minute it looks in the shared database for Draft
 * applications with a job description and no Resume yet, and makes them one at
 * a time, oldest first. Skip rows are never Draft, so they are never made.
 *
 * Runs on this computer only when CHATGPT_AUTO_MAKE=true, started from
 * `src/index.ts` (the local server) — never the deployed one — and makes
 * nothing while the Start / Stop button on romva.space is at Stop
 * (`auto-make-state.ts`); it still checks in, so the button can tell this
 * computer is up. When ChatGPT itself is unavailable (signed
 * out), the watcher pauses and tries again each minute; a Make that fails for
 * the application's own reasons (no prompt, a bad answer…) is retried after
 * five minutes, then hourly after three misses, so one broken row does not
 * hold up the rest.
 */

/** Often enough that Start on romva.space takes effect in seconds, not a minute. */
const POLL_MS = Number(process.env.CHATGPT_AUTO_MAKE_POLL_MS) || 15_000;
const RETRY_AFTER_MS = 60 * 60_000;
/** Only applications added in this window: a fresh start does not make the whole history. */
const LOOKBACK_DAYS = Number(process.env.CHATGPT_AUTO_MAKE_DAYS) || 7;

const failedAt = new Map<string, number>();
/** Failed attempts per application, for the retry delay. */
const failures = new Map<string, number>();
const SOON_MS = 5 * 60_000;
let busy = false;
/** ChatGPT was unavailable on the last try: logged once, until a Make goes through. */
let waitingForChatGpt = false;

export function startAutoMakeWatcher(): void {
  if (process.env.CHATGPT_AUTO_MAKE?.trim().toLowerCase() !== 'true') return;
  logger.info({ pollMs: POLL_MS, lookbackDays: LOOKBACK_DAYS }, 'Auto Make watcher started');
  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref();
  // Checked in every 30s even in the middle of a Make (which takes minutes),
  // so romva.space does not take a busy computer for one that is off.
  const heartbeat = setInterval(() => {
    reportWorker({}).catch((error) => logger.warn({ err: error }, 'Auto Make could not check in'));
  }, 30_000);
  heartbeat.unref();
  void tick();
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    // Stopped on romva.space: check in (so the button knows this computer is
    // up) and do nothing else.
    if (!(await autoMakeEnabled())) {
      await reportWorker({ current: null, waitingReason: null });
      return;
    }
    // Paused for ChatGPT: look at the window without reloading it (a reload
    // would throw away a sign-in in progress) and carry on once it is ready.
    if (waitingForChatGpt && !(await chatGptReady())) {
      await reportWorker({ current: null });
      return;
    }
    while (true) {
      // Stop pressed between two applications: finish here.
      if (!(await autoMakeEnabled())) {
        await reportWorker({ current: null, waitingReason: null });
        return;
      }
      const next = await nextWaiting();
      if (!next) {
        await reportWorker({ current: null, waitingReason: null });
        return;
      }
      await reportWorker({ current: { bidId: next.id, company: next.company }, waitingReason: null });
      // The application's owner, so the Make sees exactly what they would.
      const actor: Actor = { id: next.userId, role: next.user.role === 'ADMIN' ? 'admin' : 'user' };
      if (!waitingForChatGpt) {
        logger.info({ bidId: next.id, number: next.number, company: next.company }, 'Auto Make: starting');
      }
      try {
        const made = await makeResumeWithChatGpt(actor, next.id);
        failedAt.delete(next.id);
        failures.delete(next.id);
        logger.info(
          { bidId: next.id, savedTo: made.savedTo, saveError: made.saveError, coverLetterError: made.coverLetterError },
          'Auto Make finished',
        );
        waitingForChatGpt = false;
      } catch (error) {
        // ChatGPT itself unavailable (signed out, window closed): not this
        // application's fault. Leave it waiting and try again next minute,
        // saying so once rather than once a minute.
        if (error instanceof ServiceUnavailableError) {
          if (!waitingForChatGpt) {
            logger.warn({ reason: error.message }, 'Auto Make paused: waiting for ChatGPT');
          }
          waitingForChatGpt = true;
          await reportWorker({ current: null, waitingReason: error.message });
          return;
        }
        // This application's own failure (an answer that could not be read…):
        // tried again a few minutes later, then hourly after the third miss.
        const attempts = (failures.get(next.id) ?? 0) + 1;
        failures.set(next.id, attempts);
        failedAt.set(next.id, Date.now());
        logger.error({ err: error, bidId: next.id, company: next.company, attempts }, 'Auto Make failed; will retry');
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Auto Make watcher could not reach the database');
  } finally {
    busy = false;
  }
}

/** The oldest Draft application with a job description and no Resume, not recently failed or in flight. */
async function nextWaiting() {
  const now = Date.now();
  const skip = new Set(makingNow());
  for (const [id, at] of failedAt) {
    const wait = (failures.get(id) ?? 0) >= 3 ? RETRY_AFTER_MS : SOON_MS;
    if (now - at < wait) skip.add(id);
    else failedAt.delete(id);
  }

  return prisma.bid.findFirst({
    where: {
      status: 'DRAFT',
      createdAt: { gte: new Date(now - LOOKBACK_DAYS * 24 * 60 * 60_000) },
      jobDescription: { not: null },
      NOT: [{ jobDescription: '' }],
      resumeDocument: { equals: PrismaTypes.AnyNull },
      resumeFiles: { none: {} },
      ...(skip.size ? { id: { notIn: [...skip] } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, number: true, company: true, userId: true, user: { select: { role: true } } },
  });
}
