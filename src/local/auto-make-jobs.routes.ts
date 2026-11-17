import { Router } from 'express';
import { z } from 'zod';
import { currentActor } from '../auth/actor.js';
import { requireAuth } from '../auth/require-auth.js';
import { assertBidAccess, bidAccessScope } from '../bids/bids.service.js';
import { BadRequestError, ConflictError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { logger } from '../logger.js';
import { autoMakeEnabled, reportWorker } from './auto-make-state.js';
import { claimNext, completeClaim, isClaimed, releaseClaim, touchClaim } from './auto-make-queue.js';
import { finishCoverLetter, finishResume, prepareMake } from './make-steps.js';

/**
 * The automatic Resume maker for workers on other computers — the Chrome
 * extension (`resume_extension/`) and the desktop agent (`resume_agent/`).
 * They hold the ChatGPT side; everything else happens here, the same as for
 * the local API's own watcher:
 *
 *   POST /api/auto-make/claim                      → the next application and its first message
 *   POST /api/auto-make/jobs/:bidId/resume         { answer } → Resume files + the second message
 *   POST /api/auto-make/jobs/:bidId/cover-letter   { answer } → cover letter files; done
 *   POST /api/auto-make/jobs/:bidId/release        { failed, error? } → handed back
 *
 * Signed in as the person whose applications they make: an admin's worker
 * takes any application, anyone else's only those they can see.
 */

const WorkerSchema = z.object({ worker: z.string().trim().min(1).max(120) });
const AnswerSchema = z.object({ answer: z.string().min(1).max(500_000) });
const ReleaseSchema = z.object({ failed: z.boolean(), error: z.string().max(5000).optional() });
const BidParamsSchema = z.object({ bidId: z.string().uuid() });

type WorkerBody = z.infer<typeof WorkerSchema>;
type AnswerBody = z.infer<typeof AnswerSchema>;
type ReleaseBody = z.infer<typeof ReleaseSchema>;
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

autoMakeJobsRouter.post('/claim', validate({ body: WorkerSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { worker } = (req as ValidatedRequest<WorkerBody>).valid.body;

  if (!(await autoMakeEnabled())) {
    await reportWorker({});
    res.json({ enabled: false, job: null });
    return;
  }

  // A few tries: an application that cannot even be prepared (its Profile has
  // no Resume prompt yet…) is counted as failed and the next one is offered.
  for (let tries = 0; tries < 3; tries += 1) {
    const claimed = await claimNext(bidAccessScope(actor), worker);
    if (!claimed) break;
    try {
      const job = await prepareMake(actor, claimed.id);
      await reportWorker({ current: { bidId: claimed.id, company: claimed.company }, waitingReason: null });
      res.json({
        enabled: true,
        job: {
          bidId: claimed.id,
          number: claimed.number,
          company: job.bid.company,
          role: job.bid.role,
          profileFolderName: job.profileFolderName,
          folderName: job.folderName,
          resumeMessage: job.resumeMessage,
        },
      });
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn({ bidId: claimed.id, worker, reason }, 'Auto Make: could not prepare the application');
      await releaseClaim(claimed.id, { failed: true, error: reason });
    }
  }

  await reportWorker({});
  res.json({ enabled: true, job: null });
});

autoMakeJobsRouter.post(
  '/jobs/:bidId/resume',
  validate({ params: BidParamsSchema, body: AnswerSchema }),
  async (req, res) => {
    const actor = currentActor(req);
    const { params, body } = (req as ValidatedRequest<AnswerBody, BidParams>).valid;
    if (!(await isClaimed(params.bidId))) {
      throw new ConflictError('This application is not being made by a worker any more. Ask for the next one.');
    }
    try {
      const job = await prepareMake(actor, params.bidId);
      const done = await finishResume(job, body.answer);
      await touchClaim(params.bidId);
      res.json({ files: done.files, coverLetterMessage: done.coverLetterMessage });
    } catch (error) {
      if (isAnswerProblem(error)) {
        await releaseClaim(params.bidId, { failed: true, error: error instanceof Error ? error.message : String(error) });
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
    if (!(await isClaimed(params.bidId))) {
      throw new ConflictError('This application is not being made by a worker any more.');
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
    await releaseClaim(params.bidId, body);
    await reportWorker({ current: null, ...(body.failed ? {} : { waitingReason: body.error ?? null }) });
    res.json({ released: true });
  },
);
