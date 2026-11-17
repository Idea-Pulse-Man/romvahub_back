import { Router } from 'express';
import { z } from 'zod';
import { currentActor, type Actor } from '../auth/actor.js';
import { requireAuth } from '../auth/require-auth.js';
import { assertBidAccess, bidAccessScope } from '../bids/bids.service.js';
import { BadRequestError, ConflictError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { logger } from '../logger.js';
import { autoMakeEnabled, reportWorker } from './auto-make-state.js';
import {
  claimNext,
  completeClaim,
  isClaimed,
  releaseClaim,
  releaseHeldBy,
  touchClaim,
} from './auto-make-queue.js';
import { coverLetterMessageFromStoredResume, finishCoverLetter, finishResume, prepareMake } from './make-steps.js';

/**
 * The automatic Resume maker for workers on other computers — the Chrome
 * extension (`resume_extension/`) and the desktop agent (`resume_agent/`).
 * They hold the ChatGPT side; everything else happens here, the same as for
 * the local API's own watcher:
 *
 *   POST /api/auto-make/claim                      { worker, letterOnlyJobs? } → the next application and its first message
 *   POST /api/auto-make/jobs/:bidId/resume         { answer, worker? } → Resume files + the second message
 *   POST /api/auto-make/jobs/:bidId/cover-letter   { answer, worker? } → cover letter files; done
 *   POST /api/auto-make/jobs/:bidId/release        { failed, error?, worker? } → handed back
 *   POST /api/auto-make/heartbeat                  { worker, bidId?, waitingReason? } → still here (and still on bidId)
 *   POST /api/auto-make/release-held               { worker } → everything this worker held, handed back (on start)
 *
 * `worker` on a step: the step is refused (409) unless that worker still
 * holds the application, and a release only hands back that worker's own
 * hold. Left out (older workers), any hold will do, as before.
 *
 * `letterOnlyJobs`: the worker can also take an application whose Resume is
 * stored but whose cover letter failed; such a job comes with `letterOnly:
 * true` and its `coverLetterMessage`, and goes straight to the cover-letter step.
 *
 * Signed in as the person whose applications they make: an admin's worker
 * takes any application, anyone else's only those they can see.
 */

const WorkerName = z.string().trim().min(1).max(120);
const ClaimSchema = z.object({ worker: WorkerName, letterOnlyJobs: z.boolean().optional() });
const AnswerSchema = z.object({ answer: z.string().min(1).max(500_000), worker: WorkerName.optional() });
const ReleaseSchema = z.object({
  failed: z.boolean(),
  error: z.string().max(5000).optional(),
  worker: WorkerName.optional(),
});
const HeartbeatSchema = z.object({
  worker: WorkerName,
  bidId: z.string().uuid().optional(),
  waitingReason: z.string().max(2000).nullable().optional(),
});
const ReleaseHeldSchema = z.object({ worker: WorkerName });
const BidParamsSchema = z.object({ bidId: z.string().uuid() });

type ClaimBody = z.infer<typeof ClaimSchema>;
type AnswerBody = z.infer<typeof AnswerSchema>;
type ReleaseBody = z.infer<typeof ReleaseSchema>;
type HeartbeatBody = z.infer<typeof HeartbeatSchema>;
type ReleaseHeldBody = z.infer<typeof ReleaseHeldSchema>;
type BidParams = z.infer<typeof BidParamsSchema>;

export const autoMakeJobsRouter: Router = Router();
autoMakeJobsRouter.use(requireAuth);

/** Errors that are the answer's fault (count against the application) vs. everything else. */
function isAnswerProblem(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  const text = error instanceof Error ? error.message : '';
  if (/EMAXCONNSESSION|max clients reached|Can't reach database|Connection terminated/i.test(text)) return false;
  return status === 400 || status === 502;
}

/**
 * The next application of one kind for `worker`, prepared: a few tries, since
 * one that cannot even be prepared (its Profile has no Resume prompt yet, its
 * stored Resume has no text…) is counted as failed and the next one is offered.
 */
async function claimPrepared(actor: Actor, worker: string, letterOnly: boolean) {
  for (let tries = 0; tries < 3; tries += 1) {
    const claimed = await claimNext(bidAccessScope(actor), worker, { letterOnly });
    if (!claimed) return null;
    try {
      const job = await prepareMake(actor, claimed.id);
      const coverLetterMessage = letterOnly ? await coverLetterMessageFromStoredResume(job) : null;
      await reportWorker({ current: { bidId: claimed.id, company: claimed.company }, waitingReason: null });
      return {
        bidId: claimed.id,
        number: claimed.number,
        company: job.bid.company,
        role: job.bid.role,
        profileFolderName: job.profileFolderName,
        folderName: job.folderName,
        letterOnly,
        ...(letterOnly ? { coverLetterMessage } : { resumeMessage: job.resumeMessage }),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn({ bidId: claimed.id, worker, reason, letterOnly }, 'Auto Make: could not prepare the application');
      await releaseClaim(claimed.id, { failed: true, error: letterOnly ? `Cover letter: ${reason}` : reason }, worker);
    }
  }
  return null;
}

autoMakeJobsRouter.post('/claim', validate({ body: ClaimSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { worker, letterOnlyJobs } = (req as ValidatedRequest<ClaimBody>).valid.body;

  if (!(await autoMakeEnabled())) {
    await reportWorker({});
    res.json({ enabled: false, job: null });
    return;
  }

  // New Resumes first; then, for a worker that can take them, stored Resumes
  // whose cover letter is missing.
  const job =
    (await claimPrepared(actor, worker, false)) ?? (letterOnlyJobs ? await claimPrepared(actor, worker, true) : null);
  if (!job) await reportWorker({});
  res.json({ enabled: true, job });
});

autoMakeJobsRouter.post(
  '/jobs/:bidId/resume',
  validate({ params: BidParamsSchema, body: AnswerSchema }),
  async (req, res) => {
    const actor = currentActor(req);
    const { params, body } = (req as ValidatedRequest<AnswerBody, BidParams>).valid;
    if (!(await isClaimed(params.bidId, body.worker))) {
      throw new ConflictError('This application is not being made by this worker any more. Ask for the next one.');
    }
    try {
      const job = await prepareMake(actor, params.bidId);
      const done = await finishResume(job, body.answer);
      await touchClaim(params.bidId, body.worker);
      res.json({ files: done.files, coverLetterMessage: done.coverLetterMessage });
    } catch (error) {
      if (isAnswerProblem(error)) {
        await releaseClaim(
          params.bidId,
          { failed: true, error: error instanceof Error ? error.message : String(error) },
          body.worker,
        );
      }
      throw error;
    }
  },
);

autoMakeJobsRouter.post(
  '/jobs/:bidId/cover-letter',
  validate({ params: BidParamsSchema, body: AnswerSchema }),
  async (req, res) => {
    const actor = currentActor(req);
    const { params, body } = (req as ValidatedRequest<AnswerBody, BidParams>).valid;
    if (!(await isClaimed(params.bidId, body.worker))) {
      throw new ConflictError('This application is not being made by this worker any more.');
    }
    const job = await prepareMake(actor, params.bidId);
    const done = await finishCoverLetter(job, body.answer);
    await completeClaim(params.bidId);
    await reportWorker({ current: null });
    res.json({ files: done.files });
  },
);

autoMakeJobsRouter.post(
  '/jobs/:bidId/release',
  validate({ params: BidParamsSchema, body: ReleaseSchema }),
  async (req, res) => {
    const actor = currentActor(req);
    const { params, body } = (req as ValidatedRequest<ReleaseBody, BidParams>).valid;
    // Only someone who can see the application may hand it back.
    await assertBidAccess(actor, params.bidId);
    if (body.failed && !body.error) throw new BadRequestError('Say why it failed.');
    await releaseClaim(params.bidId, { failed: body.failed, error: body.error }, body.worker);
    await reportWorker({ current: null, ...(body.failed ? {} : { waitingReason: body.error ?? null }) });
    res.json({ released: true });
  },
);

/**
 * A worker's check-in, every minute or so: keeps it shown as running on
 * romva.space while a Make takes minutes, and — with `bidId` — renews its
 * hold on that application, so a slow ChatGPT does not lose it to another
 * worker. 409 when the hold is gone (ran out, or another worker has it).
 */
autoMakeJobsRouter.post('/heartbeat', validate({ body: HeartbeatSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { worker, bidId, waitingReason } = (req as ValidatedRequest<HeartbeatBody>).valid.body;
  await reportWorker(waitingReason !== undefined ? { waitingReason } : {});
  if (bidId) {
    await assertBidAccess(actor, bidId);
    if (!(await touchClaim(bidId, worker))) {
      throw new ConflictError('This application is not held by this worker any more.');
    }
  }
  res.json({ ok: true });
});

/** A worker just started: whatever its previous run held is free again at once, uncounted. */
autoMakeJobsRouter.post('/release-held', validate({ body: ReleaseHeldSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { worker } = (req as ValidatedRequest<ReleaseHeldBody>).valid.body;
  const released = await releaseHeldBy(bidAccessScope(actor), worker);
  if (released > 0) logger.info({ worker, released }, 'Auto Make: released applications held by the previous run');
  res.json({ released });
});
