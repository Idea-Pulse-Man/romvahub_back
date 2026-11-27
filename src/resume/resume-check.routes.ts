import { Router } from 'express';
import { z } from 'zod';
import { currentActor, isAdmin, type Actor } from '../auth/actor.js';
import { requireAuth } from '../auth/require-auth.js';
import { assertBidAccess, bidAccessScope } from '../bids/bids.service.js';
import { Prisma as PrismaTypes } from '../generated/prisma/client.js';
import { BadRequestError, ForbiddenError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { cancelMakeRequest, cancelRemakes, requestMake } from '../local/auto-make-queue.js';
import { logger } from '../logger.js';
import { prisma } from '../prisma.js';
import { acceptBid, checkAll, checkBid, HAS_RESUME, loadIgnore, saveIgnore } from './resume-check.js';

/**
 * The Resume check and Remake, for the desktop app's Resume Maker page and
 * Applications table. Everyone works within their own reach (an admin: every
 * Profile, or the one picked); a Profile token within its Profile.
 *
 *   GET    /api/resume-check/summary?profileId   counts + the flagged Drafts
 *   POST   /api/resume-check/run      { profileId? }   check every Draft with a Resume
 *   POST   /api/resume-check/bids/:id                  check one application
 *   POST   /api/resume-check/bids/:id/accept           "Looks fine": passed from now on (until it changes)
 *   POST   /api/resume-check/remake   { ids? | flagged: true, profileId? }
 *   DELETE /api/resume-check/remake/:id                take a remake back
 *   DELETE /api/resume-check/remake?profileId          Stop: take back every remake in reach
 *   GET    /api/resume-check/settings                  the ignore list
 *   PUT    /api/resume-check/settings { ignore }       save it (admins)
 */
export const resumeCheckRouter: Router = Router();
resumeCheckRouter.use(requireAuth);

const ProfileQuerySchema = z.object({ profileId: z.uuid().optional() });
const IdParamsSchema = z.object({ id: z.uuid() });
const RemakeSchema = z
  .object({
    ids: z.array(z.uuid()).max(2000).optional(),
    flagged: z.boolean().optional(),
    profileId: z.uuid().optional(),
  })
  .refine((v) => (v.ids?.length ?? 0) > 0 || v.flagged === true, { message: 'Send `ids`, or `flagged: true`.' });

const SettingsSchema = z.object({ ignore: z.array(z.string().max(500)).max(500) });

type ProfileQuery = z.infer<typeof ProfileQuerySchema>;
type SettingsBody = z.infer<typeof SettingsSchema>;
type IdParams = z.infer<typeof IdParamsSchema>;
type RemakeBody = z.infer<typeof RemakeSchema>;

/** The caller's reach, narrowed to one Profile when asked (a token is held to its own anyway). */
function scope(actor: Actor, profileId: string | undefined): PrismaTypes.BidWhereInput {
  return { AND: [bidAccessScope(actor), ...(profileId ? [{ profileId }] : [])] };
}

const DRAFTS_WITH_RESUME = (where: PrismaTypes.BidWhereInput): PrismaTypes.BidWhereInput => ({
  AND: [where, { status: 'DRAFT' }, HAS_RESUME],
});

resumeCheckRouter.get('/summary', validate({ query: ProfileQuerySchema }), async (req, res) => {
  const actor = currentActor(req);
  const { profileId } = (req as ValidatedRequest<unknown, unknown, ProfileQuery>).valid.query;
  const where = DRAFTS_WITH_RESUME(scope(actor, profileId));
  const [ok, flagged, unchecked, remaking, last, rows] = await Promise.all([
    prisma.bid.count({ where: { AND: [where, { resumeCheckStatus: 'ok' }] } }),
    prisma.bid.count({ where: { AND: [where, { resumeCheckStatus: 'flagged' }] } }),
    prisma.bid.count({ where: { AND: [where, { resumeCheckStatus: null }] } }),
    // Every remake waiting in reach (a flagged one or not): what Stop takes back.
    prisma.bid.count({ where: { AND: [scope(actor, profileId), { autoMakeClaim: { remake: true } }] } }),
    prisma.bid.aggregate({ where, _max: { resumeCheckedAt: true } }),
    prisma.bid.findMany({
      where: { AND: [where, { resumeCheckStatus: 'flagged' }] },
      orderBy: [{ number: 'asc' }, { id: 'asc' }],
      take: 500,
      select: {
        id: true,
        number: true,
        company: true,
        role: true,
        resumeCheckReasons: true,
        resumeCheckedAt: true,
        coverLetterDocument: true,
        profile: { select: { id: true, firstName: true, lastName: true } },
        autoMakeClaim: { select: { remake: true, claimedAt: true, lastError: true } },
      },
    }),
  ]);
  res.json({
    ok,
    flagged,
    unchecked,
    total: ok + flagged + unchecked,
    remaking,
    lastCheckedAt: last._max.resumeCheckedAt?.toISOString() ?? null,
    items: rows.map((row) => ({
      id: row.id,
      number: row.number,
      company: row.company,
      role: row.role,
      profile: row.profile
        ? { id: row.profile.id, name: [row.profile.firstName, row.profile.lastName].filter(Boolean).join(' ') }
        : null,
      reasons: row.resumeCheckReasons,
      checkedAt: row.resumeCheckedAt?.toISOString() ?? null,
      hasCoverLetter: row.coverLetterDocument !== null,
      remakeRequested: Boolean(row.autoMakeClaim?.remake),
      lastError: row.autoMakeClaim?.lastError ?? null,
    })),
  });
});

resumeCheckRouter.post('/run', validate({ body: ProfileQuerySchema }), async (req, res) => {
  const actor = currentActor(req);
  const { profileId } = (req as ValidatedRequest<ProfileQuery>).valid.body;
  const started = Date.now();
  const result = await checkAll(scope(actor, profileId));
  logger.info({ ...result, ms: Date.now() - started, profileId }, 'Resume check: all Drafts checked');
  res.json(result);
});

resumeCheckRouter.post('/bids/:id', validate({ params: IdParamsSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { id } = (req as ValidatedRequest<unknown, IdParams>).valid.params;
  await assertBidAccess(actor, id);
  res.json({ check: await checkBid(id) });
});

resumeCheckRouter.post('/bids/:id/accept', validate({ params: IdParamsSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { id } = (req as ValidatedRequest<unknown, IdParams>).valid.params;
  await assertBidAccess(actor, id);
  res.json({ check: await acceptBid(id) });
});

resumeCheckRouter.post('/remake', validate({ body: RemakeSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { ids, flagged, profileId } = (req as ValidatedRequest<RemakeBody>).valid.body;
  const where: PrismaTypes.BidWhereInput = {
    AND: [
      scope(actor, profileId),
      ids?.length ? { id: { in: ids } } : { status: 'DRAFT', resumeCheckStatus: 'flagged' },
      { status: { not: 'SKIP' } },
      { jobDescription: { not: null } },
      { NOT: [{ jobDescription: '' }] },
    ],
  };
  const rows = await prisma.bid.findMany({ where, select: { id: true }, orderBy: { number: 'asc' } });
  if (rows.length === 0) {
    throw new BadRequestError(
      ids?.length ? 'Nothing to remake: no such application, or it has no job description or is marked Skip.' : 'Nothing is flagged.',
    );
  }
  for (const row of rows) await requestMake(row.id, { remake: true });
  logger.info({ count: rows.length, flagged: Boolean(flagged) }, 'Resume check: remake asked for');
  res.json({ queued: rows.length });
});

resumeCheckRouter.delete('/remake/:id', validate({ params: IdParamsSchema }), async (req, res) => {
  const actor = currentActor(req);
  const { id } = (req as ValidatedRequest<unknown, IdParams>).valid.params;
  await assertBidAccess(actor, id);
  await cancelMakeRequest(id);
  res.json({ remakeRequested: false });
});

resumeCheckRouter.delete('/remake', validate({ query: ProfileQuerySchema }), async (req, res) => {
  const actor = currentActor(req);
  const { profileId } = (req as ValidatedRequest<unknown, unknown, ProfileQuery>).valid.query;
  const stopped = await cancelRemakes(scope(actor, profileId));
  logger.info({ stopped, profileId }, 'Resume check: remakes stopped');
  res.json({ stopped });
});

resumeCheckRouter.get('/settings', async (req, res) => {
  const actor = currentActor(req);
  res.json({ ignore: await loadIgnore(), canEdit: isAdmin(actor) && !actor.profileId });
});

resumeCheckRouter.put('/settings', validate({ body: SettingsSchema }), async (req, res) => {
  const actor = currentActor(req);
  if (!isAdmin(actor) || actor.profileId) throw new ForbiddenError('Only an admin may change the Resume check’s ignore list.');
  const { ignore } = (req as ValidatedRequest<SettingsBody>).valid.body;
  res.json({ ignore: await saveIgnore(ignore) });
});
