import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { prisma } from '../prisma.js';
import { retryAllNow } from './auto-make-queue.js';

/**
 * The two switches on romva.space — Start resume / Stop (the automatic Resume
 * maker) and Start apply / Stop (the desktop agents' Apply) — and the maker's status — shared
 * through the database between romva.space (the button, served by the deployed
 * API) and the computer that runs the maker (`auto-make-watcher.ts`).
 */

/** A maker that has not checked in for this long is reported as not running. */
const ONLINE_WITHIN_MS = 2 * 60_000;

export interface AutoMakeStatus {
  /** Start resume / Stop: the workers make Resumes and cover letters. */
  enabled: boolean;
  /** Start apply / Stop: the desktop agents open and fill in application forms. */
  applyEnabled: boolean;
  /** Whether the maker (the computer with the ChatGPT window) checked in recently. */
  workerOnline: boolean;
  workerSeenAt: string | null;
  /** The application being made now. */
  current: { bidId: string; company: string | null } | null;
  /** Why the maker is waiting (ChatGPT signed out…), when it is. */
  waitingReason: string | null;
}

async function row() {
  return prisma.autoMakeState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

export async function autoMakeEnabled(): Promise<boolean> {
  return (await row()).enabled;
}

export async function getAutoMakeStatus(): Promise<AutoMakeStatus> {
  const state = await row();
  const online = !!state.workerSeenAt && Date.now() - state.workerSeenAt.getTime() < ONLINE_WITHIN_MS;
  return {
    enabled: state.enabled,
    applyEnabled: state.applyEnabled,
    workerOnline: online,
    workerSeenAt: state.workerSeenAt?.toISOString() ?? null,
    current: online && state.currentBidId ? { bidId: state.currentBidId, company: state.currentCompany } : null,
    waitingReason: online ? state.waitingReason : null,
  };
}

/** Either switch, or both; one left out keeps its value. */
export async function setSwitches(next: { enabled?: boolean; applyEnabled?: boolean }): Promise<AutoMakeStatus> {
  await prisma.autoMakeState.upsert({ where: { id: 1 }, create: { id: 1, ...next }, update: next });
  // Start resume: everything missing a Resume or a cover letter is tried again
  // now, earlier failures included.
  if (next.enabled) await retryAllNow();
  return getAutoMakeStatus();
}

/** The maker's check-in: alive now, making this (or nothing), waiting for this (or not). */
export async function reportWorker(report: {
  current?: { bidId: string; company: string } | null;
  waitingReason?: string | null;
}): Promise<void> {
  const data = {
    workerSeenAt: new Date(),
    ...(report.current !== undefined
      ? { currentBidId: report.current?.bidId ?? null, currentCompany: report.current?.company ?? null }
      : {}),
    ...(report.waitingReason !== undefined ? { waitingReason: report.waitingReason } : {}),
  };
  await prisma.autoMakeState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
}

const SetAutoMakeSchema = z
  .object({ enabled: z.boolean().optional(), applyEnabled: z.boolean().optional() })
  .refine((body) => body.enabled !== undefined || body.applyEnabled !== undefined, {
    message: 'Send enabled, applyEnabled, or both.',
  });

export const autoMakeRouter: Router = Router();
autoMakeRouter.use(requireAuth);

autoMakeRouter.get('/', async (_req, res) => {
  res.json(await getAutoMakeStatus());
});

autoMakeRouter.put('/', validate({ body: SetAutoMakeSchema }), async (req, res) => {
  const body = (req as ValidatedRequest<z.infer<typeof SetAutoMakeSchema>>).valid.body;
  res.json(await setSwitches(body));
});
