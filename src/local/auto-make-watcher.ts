import { hostname } from 'node:os';
import type { Actor } from '../auth/actor.js';
import { ServiceUnavailableError } from '../http/errors.js';
import { logger } from '../logger.js';
import { makeCoverLetterOnly, makeResumeWithChatGpt } from './chatgpt-resume.js';
import { claimNext, completeClaim, releaseAllHeldBy, releaseClaim, retryAllNow } from './auto-make-queue.js';
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
 * out), the watcher pauses and tries again each minute.
 *
 * It takes applications from the queue every worker shares
 * (`auto-make-queue.ts`) — the Chrome extension and the desktop agent on other
 * computers too — so no application is made twice, and a failed one waits
 * (five minutes, then hourly after three misses) wherever it is tried next.
 */

/** The database could not be reached or was full — a pause, not a failure of the application. */
function isDatabaseOutage(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /EMAXCONNSESSION|max clients reached|Can't reach database|Connection terminated|ECONNRESET|ETIMEDOUT|timeout exceeded when trying to connect|expired transaction/i.test(text);
}

/** This watcher's name in the queue. */
const WORKER = `local-api · ${hostname()}`;

/** Often enough that Start on romva.space takes effect in seconds, not a minute. */
const POLL_MS = Number(process.env.CHATGPT_AUTO_MAKE_POLL_MS) || 15_000;
let busy = false;
/** The switch as last seen (null: not yet looked), to notice Start being pressed. */
let wasEnabled: boolean | null = null;
/** ChatGPT was unavailable on the last try: logged once, until a Make goes through. */
let waitingForChatGpt = false;

export function startAutoMakeWatcher(): void {
  if (process.env.CHATGPT_AUTO_MAKE?.trim().toLowerCase() !== 'true') return;
  logger.info({ pollMs: POLL_MS }, 'Auto Make watcher started');
  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref();
  // Checked in every 30s even in the middle of a Make (which takes minutes),
  // so romva.space does not take a busy computer for one that is off.
  const heartbeat = setInterval(() => {
    reportWorker({}).catch((error) => logger.warn({ err: error }, 'Auto Make could not check in'));
  }, 30_000);
  heartbeat.unref();
  // Whatever this computer's previous run was making when it stopped is free
  // again at once, rather than after the 15-minute hold runs out.
  void releaseAllHeldBy(WORKER)
    .then((released) => {
      if (released > 0) logger.info({ released }, 'Auto Make: released applications held by the previous run');
    })
    .catch((error) => logger.warn({ err: error }, 'Auto Make: could not release earlier holds'))
    .finally(() => void tick());
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    // Stopped on romva.space: check in (so the button knows this computer is
    // up) and do nothing else.
    const enabled = await autoMakeEnabled();
    if (!enabled) {
      wasEnabled = false;
      await reportWorker({ current: null, waitingReason: null });
      return;
    }
    // Start pressed since the last look: earlier failures are tried again now
    // (also done by the API on Start; this covers an API that predates it).
    if (wasEnabled === false) {
      const reset = await retryAllNow();
      if (reset > 0) logger.info({ reset }, 'Auto Make: Start — retrying earlier failures now');
    }
    wasEnabled = true;
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
      // Every application, whoever's: this computer works for them all. New
      // Resumes first; then any stored Resume whose cover letter is missing.
      let letterOnly = false;
      let next = await claimNext({}, WORKER);
      if (!next) {
        next = await claimNext({}, WORKER, { letterOnly: true });
        letterOnly = !!next;
      }
      if (!next) {
        await reportWorker({ current: null, waitingReason: null });
        return;
      }
      await reportWorker({ current: { bidId: next.id, company: next.company }, waitingReason: null });
      // The application's owner, so the Make sees exactly what they would.
      const actor: Actor = { id: next.userId, role: next.user.role === 'ADMIN' ? 'admin' : 'user' };
      if (!waitingForChatGpt) {
        logger.info({ bidId: next.id, number: next.number, company: next.company, letterOnly }, 'Auto Make: starting');
      }
      try {
        if (letterOnly) {
          const letter = await makeCoverLetterOnly(actor, next.id);
          await completeClaim(next.id);
          logger.info({ bidId: next.id, company: next.company, savedTo: letter.savedTo }, 'Auto Make: cover letter added');
          waitingForChatGpt = false;
          continue;
        }
        const made = await makeResumeWithChatGpt(actor, next.id);
        // The letter failed even after its retry: counted, so it is tried
        // again later on its own (letter-only), not left missing for good.
        if (made.coverLetterError) {
          await releaseClaim(next.id, { failed: true, error: `Cover letter: ${made.coverLetterError}` });
        } else {
          await completeClaim(next.id);
        }
        logger.info(
          { bidId: next.id, savedTo: made.savedTo, saveError: made.saveError, coverLetterError: made.coverLetterError },
          'Auto Make finished',
        );
        waitingForChatGpt = false;
      } catch (error) {
        // The database out of reach (pooler full, network): nobody's fault
        // here. Hand the application back uncounted and stop until next tick.
        if (isDatabaseOutage(error)) {
          await releaseClaim(next.id, { failed: false }).catch(() => undefined);
          logger.warn({ reason: error instanceof Error ? error.message.slice(-200) : String(error) }, 'Auto Make paused: database unavailable');
          return;
        }
        // ChatGPT itself unavailable (signed out, window closed): not this
        // application's fault. Leave it waiting and try again next minute,
        // saying so once rather than once a minute.
        if (error instanceof ServiceUnavailableError) {
          await releaseClaim(next.id, { failed: false });
          if (!waitingForChatGpt) {
            logger.warn({ reason: error.message }, 'Auto Make paused: waiting for ChatGPT');
          }
          waitingForChatGpt = true;
          await reportWorker({ current: null, waitingReason: error.message });
          return;
        }
        // This application's own failure (an answer that could not be read…):
        // tried again a few minutes later, then hourly after the third miss.
        const reason = error instanceof Error ? error.message : String(error);
        await releaseClaim(next.id, { failed: true, error: reason }).catch(() => undefined);
        logger.error({ err: error, bidId: next.id, company: next.company }, 'Auto Make failed; will retry');
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Auto Make watcher could not reach the database');
  } finally {
    busy = false;
  }
}
