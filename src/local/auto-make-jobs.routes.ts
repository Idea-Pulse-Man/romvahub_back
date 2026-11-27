import { Router } from 'express';
import { z } from 'zod';
import { currentActor, type Actor } from '../auth/actor.js';
import { requireAuth } from '../auth/require-auth.js';
import { assertBidAccess, bidAccessScope } from '../bids/bids.service.js';
import { BadRequestError, ConflictError, NotFoundError } from '../http/errors.js';
import { prisma } from '../prisma.js';
import { computerFor, savedMethod } from './maker-computers.js';
import { assertReadyToMake } from '../profiles/profile-prompts.service.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { logger } from '../logger.js';
import { autoMakeEnabled, reportWorker } from './auto-make-state.js';
import {
  cancelMakeRequest,
  claimNext,
  type ClaimKind,
  completeClaim,
  isClaimed,
  releaseClaim,
  releaseHeldBy,
  requestMake,
  touchClaim,
  type ComputerChoice,
} from './auto-make-queue.js';
import {
  checkResumeAnswer,
  coverLetterMessageFromStoredResume,
  finishCoverLetter,
  finishResume,
  prepareMake,
} from './make-steps.js';

/**
 * The automatic Resume maker for workers on other computers — the Chrome
 * extension (`resume_extension/`) and the desktop agent (`resume_agent/`).
 * They hold the ChatGPT side; everything else happens here, the same as for
 * the local API's own watcher:
 *
 *   POST /api/auto-make/claim                      { worker, letterOnlyJobs? } → the next application and its first message
 *   POST /api/auto-make/jobs/:bidId/check-resume   { answer, worker? } → { ok, problems, retryMessage? }; stores and counts nothing
 *   POST /api/auto-make/jobs/:bidId/resume         { answer, worker? } → Resume files + the second message
 *   POST /api/auto-make/jobs/:bidId/cover-letter   { answer, worker? } → cover letter files; done
 *   POST /api/auto-make/jobs/:bidId/release        { failed, error?, worker? } → handed back
 *   POST /api/auto-make/heartbeat                  { worker, bidId?, waitingReason? } → still here (and still on bidId)
 *   POST /api/auto-make/release-held               { worker } → everything this worker held, handed back (on start)
 *   POST   /api/auto-make/jobs/:bidId/request      "Make" clicked in the table: the workers take it next
 *   DELETE /api/auto-make/jobs/:bidId/request      the request taken back
 *
 * A requested application is handed out before every other one, and even at
 * Stop (the claim then answers `enabled: true` with it, so every worker makes it).
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
async function claimPrepared(
  actor: Actor,
  worker: string,
  kind: ClaimKind,
  requestedOnly = false,
  computer: ComputerChoice | null = null,
) {
  for (let tries = 0; tries < 3; tries += 1) {
    const claimed = await claimNext(bidAccessScope(actor), worker, { kind, requestedOnly, computer });
    if (!claimed) return null;
    const { letterOnly } = claimed;
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
        ...(claimed.remake ? { remake: true } : {}),
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

  const kind: ClaimKind = letterOnlyJobs ? 'any' : 'resume';
  // Started with the Start window: this computer's own Start / Stop, Profile, order and start No.
  // Otherwise the one switch (Start resume on the website) and ▲ / ▼.
  const computer = await computerFor(worker);
  const enabled = computer ? computer.running : await autoMakeEnabled();
  if (!enabled) {
    // At Stop only what someone asked for by clicking Make is made — handed
    // out as `enabled: true`, so a worker that waits at Stop makes it anyway.
    const requested = await claimPrepared(actor, worker, kind, true, computer);
    if (requested) {
      res.json({ enabled: true, job: requested });
      return;
    }
    await reportWorker({});
    res.json({ enabled: false, job: null });
    return;
  }

  // Down the Applications list, lowest number first: whatever the next one is
  // missing — its Resume (and letter), or, for a worker that can do it, just
  // its cover letter. (One that keeps failing waits out its back-off, so it
  // never blocks the list.)
  const job = await claimPrepared(actor, worker, kind, false, computer);
  if (!job) await reportWorker({});
  res.json({ enabled: true, job });
});

/**
 * The look at ChatGPT's Resume answer before it is handed in: readable JSON
 * that fills the template's summary, skills, job titles and bullet points?
 * Stores nothing and counts nothing. When something is missing, `retryMessage`
 * is the request again with what was missing spelled out — for one more chat.
 */
autoMakeJobsRouter.post(
  '/jobs/:bidId/check-resume',
  validate({ params: BidParamsSchema, body: AnswerSchema }),
  async (req, res) => {
    const actor = currentActor(req);
    const { params, body } = (req as ValidatedRequest<AnswerBody, BidParams>).valid;
    if (!(await isClaimed(params.bidId, body.worker))) {
      throw new ConflictError('This application is not being made by this worker any more. Ask for the next one.');
    }
    const job = await prepareMake(actor, params.bidId);
    const check = await checkResumeAnswer(job, body.answer);
    await touchClaim(params.bidId, body.worker);
    res.json({ ok: check.problems.length === 0, ...check });
  },
);

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
  // A computer started with the Start window shows online while it works on a long one too.
  if (worker) await prisma.makerComputer.updateMany({ where: { worker }, data: { seenAt: new Date() } });
  if (bidId) {
    await assertBidAccess(actor, bidId);
    if (!(await touchClaim(bidId, worker))) {
      throw new ConflictError('This application is not held by this worker any more.');
    }
  }
  res.json({ ok: true });
});

/** Make clicked in a Chrome with Romva Apply: that computer (maker.js's name), to make it now. */
const RequestMakeSchema = z.object({ worker: z.string().min(1).max(200).optional() }).optional();

/**
 * "Make" clicked on an application in the table: the Resume and cover letter
 * (or just the letter, when the Resume is there) are made next, before every
 * other waiting application, by whichever worker asks first.
 *
 * With `worker` (clicked in the app's Chrome, where Romva Apply is): that
 * computer makes it now, even never started with the Start window — it is
 * noted here (stopped: at Stop only what Make asks for is made) — provided the
 * token in its Romva Apply is for this application's Profile.
 */
autoMakeJobsRouter.post('/jobs/:bidId/request', validate({ params: BidParamsSchema, body: RequestMakeSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { bidId } = (req as ValidatedRequest<unknown, BidParams>).valid.params;
  const worker = (req as ValidatedRequest<z.infer<typeof RequestMakeSchema>>).valid.body?.worker;
  const bid = await prisma.bid.findFirst({
    where: { id: bidId, ...bidAccessScope(actor) },
    select: {
      profileId: true,
      status: true,
      jobDescription: true,
      resumeDocument: true,
      resumeAnswer: true,
      resumeKept: true,
      coverLetterDocument: true,
      _count: { select: { resumeFiles: true } },
    },
  });
  if (!bid) throw new NotFoundError('No such application.');
  if (bid.status === 'SKIP') {
    throw new BadRequestError('This application is marked Skip. Change its status to make a Resume for it.');
  }
  if (!bid.jobDescription?.trim()) {
    throw new BadRequestError('This application has no job description. Add one, then click Make again.');
  }
  const hasResume = bid.resumeAnswer !== null || bid._count.resumeFiles > 0 || bid.resumeKept || bid.resumeDocument !== null;
  if (hasResume && bid.coverLetterDocument !== null) {
    throw new BadRequestError('This application already has its Resume and cover letter.');
  }
  if (worker) {
    const computer = await prisma.makerComputer.findUnique({ where: { worker }, select: { tokenProfileId: true } });
    if (computer?.tokenProfileId && bid.profileId && computer.tokenProfileId !== bid.profileId) {
      throw new ConflictError(
        "The token in Romva Apply on this computer is for another Profile than this application's. Paste this application's Profile token in Romva Apply, then click Make again.",
      );
    }
    // The Profile must have the Resume prompts of this computer's method (two steps: Step 1's and Step 2's)
    // and its template: refused now, with what is missing, rather than failing once the maker takes it.
    if (bid.profileId) await assertReadyToMake(bid.profileId, (await savedMethod(worker)) || 'one');
    // Never started here: noted, stopped, so its next ask for work takes this one (and only what Make asks for).
    if (!computer) {
      await prisma.makerComputer.create({ data: { worker, userId: actor.id, running: false, profileId: bid.profileId, order: 'up' } });
    }
  }
  await requestMake(bidId);
  logger.info({ bidId, letterOnly: hasResume, worker }, 'Auto Make: requested from the table');
  res.json({ requested: true, letterOnly: hasResume });
});

autoMakeJobsRouter.delete('/jobs/:bidId/request', validate({ params: BidParamsSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { bidId } = (req as ValidatedRequest<unknown, BidParams>).valid.params;
  await assertBidAccess(actor, bidId);
  await cancelMakeRequest(bidId);
  res.json({ requested: false });
});

/** A worker just started: whatever its previous run held is free again at once, uncounted. */
autoMakeJobsRouter.post('/release-held', validate({ body: ReleaseHeldSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { worker } = (req as ValidatedRequest<ReleaseHeldBody>).valid.body;
  const released = await releaseHeldBy(bidAccessScope(actor), worker);
  if (released > 0) logger.info({ worker, released }, 'Auto Make: released applications held by the previous run');
  res.json({ released });
});
