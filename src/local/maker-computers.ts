import { Router } from 'express';
import { z } from 'zod';
import { currentActor, isAdmin } from '../auth/actor.js';
import { requireAdmin, requireAuth } from '../auth/require-auth.js';
import { Prisma as PrismaTypes } from '../generated/prisma/client.js';
import { ForbiddenError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { logger } from '../logger.js';
import { prisma } from '../prisma.js';
import { assertProfileAccess } from '../profiles/profile-prompts.service.js';
import type { ComputerChoice } from './auto-make-queue.js';
import { setSwitches } from './auto-make-state.js';

/**
 * The Start window: Start resume is per computer. Each computer where it was
 * started keeps its own choices here (`maker_computers`): one Profile, ▲ Up or
 * ▼ Down, the No. to start from, and the AIs. One user can run it on several
 * computers at once; the queue never hands two of them the same application.
 *
 *   GET  /api/auto-make/computers            mine (an admin: everyone's)
 *                                            (tokenProfileId: the Profile of the token in its Romva Apply)
 *   PUT  /api/auto-make/computers/:worker    Start / Stop on that computer, with its choices
 *   POST /api/auto-make/stop-all             an admin: every computer stops (and the old switch)
 */

export const makerComputersRouter: Router = Router();
makerComputersRouter.use(requireAuth);

const ChoicesSchema = z.object({
  method: z.enum(['one', 'two']),
  ai: z.enum(['chatgpt', 'deepseek', 'claude', 'gemini']),
  draftAi: z.literal('deepseek').optional(),
  letterAi: z.enum(['chatgpt', 'deepseek', 'claude', 'gemini']),
  models: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.boolean()]))).optional(),
  // The Start window's two lines: the Resume's and the cover letter's own settings for their AI.
  parts: z
    .object({
      resume: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
      letter: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
    })
    .optional(),
});

const ComputerSchema = z.object({
  running: z.boolean(),
  profileId: z.string().uuid().nullable().optional(),
  order: z.enum(['up', 'down']).default('up'),
  startFrom: z.number().int().positive().nullable().optional(),
  choices: ChoicesSchema.optional(),
});
type ComputerInput = z.infer<typeof ComputerSchema>;

const WorkerParams = z.object({ worker: z.string().min(1).max(200) });

/** Online: asked for work within the last 4 minutes (an idle maker asks at least every 3). */
const ONLINE_MS = 4 * 60_000;

function shown(row: Awaited<ReturnType<typeof prisma.makerComputer.findMany>>[number]) {
  return {
    ...row,
    online: Boolean(row.seenAt && Date.now() - row.seenAt.getTime() < ONLINE_MS),
  };
}

makerComputersRouter.get('/computers', async (req, res) => {
  const actor = currentActor(req);
  const rows = await prisma.makerComputer.findMany({
    where: isAdmin(actor) ? {} : { userId: actor.id },
    orderBy: { worker: 'asc' },
  });
  res.json(rows.map(shown));
});

makerComputersRouter.put(
  '/computers/:worker',
  validate({ params: WorkerParams, body: ComputerSchema }),
  async (req, res) => {
    const actor = currentActor(req);
    const { worker } = (req as ValidatedRequest<unknown, z.infer<typeof WorkerParams>>).valid.params;
    const body = (req as ValidatedRequest<ComputerInput>).valid.body;
    const existing = await prisma.makerComputer.findUnique({
      where: { worker },
      select: { userId: true, running: true, tokenProfileId: true },
    });
    if (existing && existing.userId !== actor.id && !isAdmin(actor)) {
      throw new ForbiddenError('This computer\'s Resume maker was started by someone else.');
    }
    // A Profile token's computer works on that Profile, whatever was sent: the token signing this
    // request, else the one its Romva Apply last asked for work with.
    const profileId = actor.profileId ?? existing?.tokenProfileId ?? body.profileId ?? null;
    // Start only for a Profile the signed-in account may use too (the token's must be the account's).
    if (body.running && profileId) {
      try {
        await assertProfileAccess(actor, profileId);
      } catch {
        throw new ForbiddenError(
          'The token in Romva Apply on this computer is for a Profile your account can\'t use. Paste the token of one of your Profiles there.',
        );
      }
    }
    // A start No. counts in one Profile's numbers only: dropped when another Profile was sent.
    const keepsStart = profileId !== null && (body.profileId == null || body.profileId === profileId);
    const data = {
      userId: actor.id,
      running: body.running,
      profileId,
      order: body.order,
      startFrom: keepsStart ? (body.startFrom ?? null) : null,
      ...(body.choices ? { choices: body.choices as PrismaTypes.InputJsonValue } : {}),
      ...(body.running && !existing?.running ? { startedAt: new Date() } : {}),
    };
    const row = await prisma.makerComputer.upsert({ where: { worker }, create: { worker, ...data }, update: data });
    logger.info({ worker, running: row.running, profileId: row.profileId, order: row.order, startFrom: row.startFrom }, 'Resume maker: computer set');
    res.json(shown(row));
  },
);

makerComputersRouter.post('/stop-all', requireAdmin, async (req, res) => {
  const { count } = await prisma.makerComputer.updateMany({ where: { running: true }, data: { running: false } });
  // The workers started the old way follow the one switch.
  await setSwitches({ enabled: false });
  logger.info({ stopped: count, by: currentActor(req).id }, 'Resume maker: Stop all');
  res.json({ stopped: count });
});

/**
 * The computer's choices, for a worker asking for work — null when it was
 * never started with the Start window (it then follows the old switch and ▲/▼).
 * Notes the ask, so the computer shows online.
 */
export async function computerFor(worker: string): Promise<(ComputerChoice & { running: boolean }) | null> {
  const row = await prisma.makerComputer.findUnique({
    where: { worker },
    select: { running: true, profileId: true, order: true, startFrom: true },
  });
  if (!row) return null;
  await prisma.makerComputer.update({ where: { worker }, data: { seenAt: new Date() } }).catch(() => undefined);
  return { running: row.running, profileId: row.profileId, down: row.order === 'down', startFrom: row.startFrom };
}
