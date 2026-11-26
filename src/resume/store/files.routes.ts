import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { currentActor } from '../../auth/actor.js';
import { requireAdmin, requireAuth } from '../../auth/require-auth.js';
import { bidAccessScope } from '../../bids/bids.service.js';
import { Prisma as PrismaTypes } from '../../generated/prisma/client.js';
import { NotFoundError } from '../../http/errors.js';
import { validate, type ValidatedRequest } from '../../http/validate.js';
import { logger } from '../../logger.js';
import { prisma } from '../../prisma.js';
import { cleanUpResumeFolder } from './cleanup.js';
import { inBackground } from './file-rules.js';
import { folderUsage, resumeFolderInfo, setResumeFolder } from './folder.js';
import { makeCopies } from './resume-store.js';
import { RangeSchema, rangeWhere, type RangeInput } from './range.js';

/**
 * The Resume folder (`/api/resume-files`):
 *
 *   GET  /folder       where it is, and how big (admin)
 *   PUT  /folder       choose another folder, or `null` for the default (admin)
 *   POST /make         "Make files": build the Word and PDF copies of the
 *                      applications in a date range and statuses
 *   GET  /make/:id     how far a "Make files" run is
 *   POST /clean-up     run the nightly clean-up now (admin)
 */

export const resumeFilesRouter: Router = Router();
resumeFilesRouter.use(requireAuth);

resumeFilesRouter.get('/folder', requireAdmin, async (_req, res) => {
  res.json({ ...(await resumeFolderInfo()), usage: await folderUsage() });
});

const FolderSchema = z.object({ folder: z.string().max(500).nullable() });

resumeFilesRouter.put('/folder', requireAdmin, validate({ body: FolderSchema }), async (req, res) => {
  const { folder } = (req as ValidatedRequest<z.infer<typeof FolderSchema>>).valid.body;
  const info = await setResumeFolder(folder);
  logger.info({ folder: info.folder, by: currentActor(req).id }, 'Resume folder changed');
  res.json(info);
});

interface MakeRun {
  id: string;
  userId: string;
  total: number;
  done: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
}

/** "Make files" runs, kept in memory for a day: what the button's progress shows. */
const runs = new Map<string, MakeRun>();
const RUN_KEEP_MS = 24 * 60 * 60 * 1000;

function forgetOldRuns(): void {
  const cutoff = Date.now() - RUN_KEEP_MS;
  for (const [id, run] of runs) if (Date.parse(run.startedAt) < cutoff) runs.delete(id);
}

resumeFilesRouter.post('/make', validate({ body: RangeSchema }), async (req, res) => {
  const actor = currentActor(req);
  const range = (req as ValidatedRequest<RangeInput>).valid.body;
  const rows = await prisma.bid.findMany({
    where: {
      AND: [
        bidAccessScope(actor),
        rangeWhere(range),
        { OR: [{ resumeAnswer: { not: PrismaTypes.AnyNull } }, { coverLetterDocument: { not: PrismaTypes.AnyNull } }] },
      ],
    },
    select: { id: true },
    orderBy: [{ bidDate: 'asc' }, { number: 'asc' }],
  });

  forgetOldRuns();
  const run: MakeRun = {
    id: randomUUID(),
    userId: actor.id,
    total: rows.length,
    done: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: rows.length ? null : new Date().toISOString(),
  };
  runs.set(run.id, run);
  // One at a time, behind any other building: a PDF takes a few seconds each.
  rows.forEach((row, index) =>
    inBackground(`make files ${row.id}`, async () => {
      try {
        await makeCopies(row.id);
        run.done += 1;
      } catch (error) {
        run.failed += 1;
        throw error;
      } finally {
        if (index === rows.length - 1) run.finishedAt = new Date().toISOString();
      }
    }),
  );
  logger.info({ run: run.id, total: run.total, range }, 'Make files started');
  res.json(run);
});

resumeFilesRouter.get('/make/:id', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, { id: string }>).valid.params;
  const run = runs.get(id);
  if (!run || run.userId !== currentActor(req).id) throw new NotFoundError('No such "Make files" run.');
  res.json(run);
});

resumeFilesRouter.post('/clean-up', requireAdmin, async (_req, res) => {
  res.json(await cleanUpResumeFolder());
});
