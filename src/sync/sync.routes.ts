import { Router } from 'express';
import { z } from 'zod';
import { currentActor, isAdmin } from '../auth/actor.js';
import { currentUserId, requireAuth } from '../auth/require-auth.js';
import * as bidsService from '../bids/bids.service.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { getAutoMakeStatus } from '../local/auto-make-state.js';
import { makingNow, resumeSaveDir } from '../local/chatgpt-resume.js';
import { prisma } from '../prisma.js';

/**
 * GET /api/sync?profileId=… — everything an open page checks for, in one request:
 *
 *   bidsVersion     changes when any application changes (the page then refetches them)
 *   notifications   { unreadCount, latestAt }: the bell refetches its list only when these move
 *   making          { bidIds, savesFiles }: what ChatGPT is making right now
 *   autoMake        the Start resume / Stop switch and the worker's state
 *
 * It replaces four separate polls (bids version, notifications, making,
 * auto-make), so an open tab costs one request per check instead of four.
 */

const SyncQuerySchema = z.object({ profileId: z.uuid().optional() });
type SyncQuery = z.infer<typeof SyncQuerySchema>;

export const syncRouter: Router = Router();

syncRouter.use(requireAuth);

syncRouter.get('/', validate({ query: SyncQuerySchema }), async (req, res) => {
  const { profileId } = (req as ValidatedRequest<unknown, unknown, SyncQuery>).valid.query;
  const actor = currentActor(req);
  const userId = currentUserId(req);

  const [bidsVersion, unreadCount, latest, autoMake] = await Promise.all([
    // An admin with no Profile chosen has no list on screen to refresh.
    isAdmin(actor) && !profileId ? Promise.resolve(null) : bidsService.bidsVersion(actor, { profileId }),
    prisma.notification.count({ where: { recipientId: userId, readAt: null } }),
    prisma.notification.findFirst({
      where: { recipientId: userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    getAutoMakeStatus(),
  ]);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    bidsVersion,
    notifications: { unreadCount, latestAt: latest?.createdAt.toISOString() ?? null },
    making: { bidIds: makingNow(), savesFiles: resumeSaveDir() !== null },
    autoMake,
  });
});
