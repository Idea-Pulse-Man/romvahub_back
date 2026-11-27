import type { Actor } from '../auth/actor.js';
import { bidAccessScope } from '../bids/bids.service.js';
import { Prisma as PrismaTypes } from '../generated/prisma/client.js';
import { ConflictError, NotFoundError } from '../http/errors.js';
import { logger } from '../logger.js';
import { prisma } from '../prisma.js';
import { claimNext, completeClaim, releaseClaim, touchClaim } from '../local/auto-make-queue.js';
import { reportWorker } from '../local/auto-make-state.js';
import { computerFor } from '../local/maker-computers.js';
import {
  checkResumeAnswer,
  coverLetterMessageFromStoredResume,
  finishCoverLetter,
  finishResume,
  prepareMake,
} from '../local/make-steps.js';
import {
  draftMarks,
  FINISHED_TEXT,
  INVALID_JSON,
  JSON_ONLY,
  jsonIn,
  nameSkillGroups,
  withDraft,
  withDraftsPointedOut,
} from './texts.js';

/**
 * The make engine: the steps of making one application's Resume and cover
 * letter, run here on the server. The browser of the computer that was started
 * (the Romva Apply extension) only does what each task says — ask this AI this
 * — and hands the answer back. So the steps, the checks and the second tries
 * are the same on every computer, and change with a server update.
 *
 *   one step:   resume (ai) → letter (letterAi)
 *   two steps:  draft (DeepSeek) → resume (ai, with the draft) → letter (letterAi)
 *
 * A Resume answer that is incomplete (romva.space's check) or a draft
 * ("[Confirm…]", "X%", an unnamed skill group) is asked for once more, with
 * the problems spelled out. A draft that is not JSON is asked for once more,
 * then left out. The application is held in the shared queue the whole time,
 * so no other computer makes it.
 */

export type Site = 'chatgpt' | 'deepseek' | 'claude' | 'gemini';
type Step = 'draft' | 'resume' | 'letter';

export interface Choices {
  method: 'one' | 'two';
  ai: Site;
  letterAi: Site;
  models: Record<string, Record<string, string | boolean>>;
}

/** The default (the user's choice, 2026-11-26): one step, ChatGPT · Chat · GPT-6 · High, the letter the same. */
export const DEFAULT_CHOICES: Choices = {
  method: 'one',
  ai: 'chatgpt',
  letterAi: 'chatgpt',
  models: {
    chatgpt: { mode: 'chat', model: 'GPT-6', effort: 'high' },
    deepseek: { deepThink: true, search: true },
    // Romva Apply 3.6.1+ sets these in claude.ai.
    claude: { model: 'Opus 5.5', thinking: true },
  },
};

/** A task given out and not answered for this long is given up (the AI page hung, the browser closed). */
const TASK_TIMEOUT_MS = 25 * 60_000;
/** A draft that could not be had: the draft AI is left alone this long on that computer. */
const DRAFT_REST_MS = 10 * 60_000;
const draftRest = new Map<string, number>();

export interface TaskForBrowser {
  id: string;
  bidId: string;
  step: Step;
  site: Site;
  message: string;
  options: { webSearch: boolean; temporary: boolean; choice: Record<string, string | boolean> };
  attempt: number;
  company: string;
  role: string;
  number: number;
}

async function choicesFor(worker: string): Promise<Choices> {
  const row = await prisma.makerComputer.findUnique({ where: { worker }, select: { choices: true } });
  const saved = (row?.choices ?? {}) as Partial<Choices>;
  const site = (value: unknown, fallback: Site): Site =>
    value === 'chatgpt' || value === 'deepseek' || value === 'claude' || value === 'gemini' ? value : fallback;
  return {
    method: saved.method === 'two' ? 'two' : 'one',
    ai: site(saved.ai, DEFAULT_CHOICES.ai),
    letterAi: site(saved.letterAi, site(saved.ai, DEFAULT_CHOICES.letterAi)),
    models: { ...DEFAULT_CHOICES.models, ...(saved.models ?? {}) },
  };
}

async function toBrowser(task: {
  id: string;
  bidId: string;
  step: string;
  site: string;
  message: string;
  options: unknown;
  attempt: number;
}): Promise<TaskForBrowser> {
  const bid = await prisma.bid.findUnique({ where: { id: task.bidId }, select: { company: true, role: true, number: true } });
  return {
    id: task.id,
    bidId: task.bidId,
    step: task.step as Step,
    site: task.site as Site,
    message: task.message,
    options: (task.options ?? { webSearch: false, temporary: true, choice: {} }) as TaskForBrowser['options'],
    attempt: task.attempt,
    company: bid?.company ?? '',
    role: bid?.role ?? '',
    number: bid?.number ?? 0,
  };
}

async function addTask(
  actor: Actor,
  worker: string,
  bidId: string,
  step: Step,
  site: Site,
  message: string,
  { attempt = 1, context = {} as Record<string, unknown> } = {},
) {
  const choices = await choicesFor(worker);
  return prisma.makerTask.create({
    data: {
      worker,
      userId: actor.id,
      bidId,
      step,
      site,
      message,
      attempt,
      context: context as PrismaTypes.InputJsonValue,
      options: {
        // Web search for the Resume (ChatGPT turns it on in the chat); every chat is a temporary one.
        webSearch: step === 'resume',
        temporary: true,
        choice: choices.models[site] ?? {},
      } as PrismaTypes.InputJsonValue,
    },
  });
}

/** Gives up the application: handed back to the queue, counted as a failure (or not, when it was not its fault). */
async function giveUp(bidId: string, worker: string, reason: string, counted: boolean): Promise<void> {
  await prisma.makerTask.updateMany({ where: { bidId, worker, status: { in: ['waiting', 'taken'] } }, data: { status: 'failed', error: reason, doneAt: new Date() } });
  await releaseClaim(bidId, { failed: counted, error: reason }, worker).catch(() => undefined);
  await reportWorker({ current: null });
  logger.info({ bidId, worker, reason, counted }, 'Maker: application given up');
}

/** The first task of a new application for this computer, or null when there is none to make. */
async function startNext(actor: Actor, worker: string): Promise<boolean> {
  let computer = await computerFor(worker);
  if (!computer) return false; // never started with the Start window: nothing for it
  // A Profile token works for its own Profile only: that one wins over the Start window's choice
  // (whose start No. counted in another Profile's numbers).
  if (actor.profileId && computer.profileId !== actor.profileId) {
    computer = { ...computer, profileId: actor.profileId, startFrom: null };
  }
  for (let tries = 0; tries < 3; tries += 1) {
    // At Stop only what someone asked for with "Make" is made.
    const claimed = await claimNext(bidAccessScope(actor), worker, { kind: 'any', requestedOnly: !computer.running, computer });
    if (!claimed) return false;
    try {
      const job = await prepareMake(actor, claimed.id);
      const choices = await choicesFor(worker);
      await reportWorker({ current: { bidId: claimed.id, company: claimed.company }, waitingReason: null });
      if (claimed.letterOnly) {
        await addTask(actor, worker, claimed.id, 'letter', choices.letterAi, await coverLetterMessageFromStoredResume(job));
      } else if (choices.method === 'two' && (draftRest.get(worker) ?? 0) < Date.now()) {
        await addTask(actor, worker, claimed.id, 'draft', 'deepseek', `${job.resumeMessage}\n\n${JSON_ONLY}`);
      } else {
        await addTask(actor, worker, claimed.id, 'resume', choices.ai, `${job.resumeMessage}\n\n${FINISHED_TEXT}`);
      }
      logger.info({ bidId: claimed.id, worker, letterOnly: claimed.letterOnly }, 'Maker: started an application');
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await giveUp(claimed.id, worker, claimed.letterOnly ? `Cover letter: ${reason}` : reason, true);
    }
  }
  return false;
}

let lastPrune = 0;
async function prune(): Promise<void> {
  if (Date.now() - lastPrune < 60 * 60_000) return;
  lastPrune = Date.now();
  await prisma.makerTask.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60_000) } } });
}

/**
 * The next task for this computer's browser: one it holds already (it lost
 * track of it), else one waiting, else the first task of a new application.
 * Null when there is nothing to do.
 */
export async function nextTask(actor: Actor, worker: string): Promise<TaskForBrowser | null> {
  await prune().catch(() => undefined);
  // Given out too long ago: the page hung or the browser was closed.
  const stale = await prisma.makerTask.findMany({
    where: { worker, status: 'taken', takenAt: { lt: new Date(Date.now() - TASK_TIMEOUT_MS) } },
    select: { bidId: true },
  });
  for (const task of stale) await giveUp(task.bidId, worker, 'The AI page did not answer in time.', true);

  const held = await prisma.makerTask.findFirst({ where: { worker, status: 'taken' }, orderBy: { createdAt: 'asc' } });
  if (held) return toBrowser(held);

  for (let round = 0; round < 2; round += 1) {
    const waiting = await prisma.makerTask.findFirst({ where: { worker, status: 'waiting' }, orderBy: { createdAt: 'asc' } });
    if (waiting) {
      const taken = await prisma.makerTask.updateMany({
        where: { id: waiting.id, status: 'waiting' },
        data: { status: 'taken', takenAt: new Date() },
      });
      if (taken.count === 1) {
        await touchClaim(waiting.bidId, worker);
        return toBrowser(waiting);
      }
      continue;
    }
    if (round === 0 && !(await startNext(actor, worker))) return null;
  }
  return null;
}

async function ownTask(worker: string, taskId: string) {
  const task = await prisma.makerTask.findUnique({ where: { id: taskId } });
  if (!task || task.worker !== worker) throw new NotFoundError('No such task for this computer.');
  if (task.status !== 'taken') throw new ConflictError('This task was already answered or given up.');
  return task;
}

/** The browser's answer to a task: the engine takes the application on to its next step. */
export async function answerTask(actor: Actor, worker: string, taskId: string, answer: string): Promise<void> {
  const task = await ownTask(worker, taskId);
  await prisma.makerTask.update({ where: { id: task.id }, data: { status: 'done', answer: answer.slice(0, 500_000), doneAt: new Date() } });
  await touchClaim(task.bidId, worker);
  const context = (task.context ?? {}) as { draft?: string | null };
  const choices = await choicesFor(worker);
  const job = await prepareMake(actor, task.bidId);

  if (task.step === 'draft') {
    const draft = jsonIn(answer);
    if (draft) {
      await addTask(actor, worker, task.bidId, 'resume', choices.ai, `${withDraft(job.resumeMessage, draft)}\n\n${FINISHED_TEXT}`, {
        context: { draft },
      });
    } else if (task.attempt < 2) {
      await addTask(actor, worker, task.bidId, 'draft', 'deepseek', `${job.resumeMessage}\n\n${INVALID_JSON}`, { attempt: 2 });
    } else {
      draftRest.set(worker, Date.now() + DRAFT_REST_MS);
      await addTask(actor, worker, task.bidId, 'resume', choices.ai, `${job.resumeMessage}\n\n${FINISHED_TEXT}`);
    }
    return;
  }

  if (task.step === 'resume') {
    const { text, unnamed } = nameSkillGroups(answer);
    const check = await checkResumeAnswer(job, text);
    const marks = [...draftMarks(text), ...unnamed.map((name) => `a skill group named "${name}" instead of its own name`)];
    if ((check.problems.length || marks.length) && task.attempt < 2) {
      let retry = check.problems.length && check.retryMessage ? check.retryMessage : job.resumeMessage;
      if (marks.length) retry = withDraftsPointedOut(retry, marks);
      await addTask(actor, worker, task.bidId, 'resume', task.site as Site, `${withDraft(retry, context.draft)}\n\n${FINISHED_TEXT}`, {
        attempt: 2,
        context,
      });
      logger.info({ bidId: task.bidId, problems: check.problems, marks }, 'Maker: Resume asked for again');
      return;
    }
    let letterMessage: string;
    try {
      letterMessage = (await finishResume(job, text)).coverLetterMessage;
    } catch (error) {
      await giveUp(task.bidId, worker, error instanceof Error ? error.message : String(error), true);
      return;
    }
    await addTask(actor, worker, task.bidId, 'letter', choices.letterAi, letterMessage);
    return;
  }

  // The cover letter.
  try {
    await finishCoverLetter(job, answer);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (task.attempt < 2) {
      await addTask(actor, worker, task.bidId, 'letter', task.site as Site, task.message, { attempt: 2 });
      return;
    }
    await giveUp(task.bidId, worker, `Cover letter: ${reason}`, true);
    return;
  }
  await completeClaim(task.bidId);
  await reportWorker({ current: null });
  logger.info({ bidId: task.bidId, worker }, 'Maker: application done');
}

/**
 * The browser could not do a task. `unavailable`: the AI site itself (signed
 * out, busy, its limit): not the application's fault — a missing draft is
 * left out; anything else hands the application back uncounted. Otherwise the
 * step is tried once more, then the application counts as failed.
 */
export async function failTask(
  actor: Actor,
  worker: string,
  taskId: string,
  { reason, unavailable }: { reason: string; unavailable: boolean },
): Promise<void> {
  const task = await ownTask(worker, taskId);
  await prisma.makerTask.update({ where: { id: task.id }, data: { status: 'failed', error: reason.slice(0, 4000), doneAt: new Date() } });
  if (task.step === 'draft') {
    // No draft: the Resume is made without one, and the draft AI rests.
    draftRest.set(worker, Date.now() + DRAFT_REST_MS);
    const job = await prepareMake(actor, task.bidId);
    const choices = await choicesFor(worker);
    await addTask(actor, worker, task.bidId, 'resume', choices.ai, `${job.resumeMessage}\n\n${FINISHED_TEXT}`);
    return;
  }
  if (unavailable) {
    await giveUp(task.bidId, worker, reason, false);
    await reportWorker({ waitingReason: reason.slice(0, 2000) });
    return;
  }
  if (task.attempt < 2) {
    await addTask(actor, worker, task.bidId, task.step as Step, task.site as Site, task.message, {
      attempt: 2,
      context: (task.context ?? {}) as Record<string, unknown>,
    });
    return;
  }
  await giveUp(task.bidId, worker, task.step === 'letter' ? `Cover letter: ${reason}` : reason, true);
}

/** Still working on it (a long answer): the application stays held. */
export async function heartbeat(worker: string, taskId: string): Promise<void> {
  const task = await prisma.makerTask.findUnique({ where: { id: taskId }, select: { worker: true, bidId: true, status: true } });
  if (!task || task.worker !== worker || task.status !== 'taken') throw new ConflictError('This task is not this computer\'s any more.');
  await prisma.makerTask.update({ where: { id: taskId }, data: { takenAt: new Date() } });
  await touchClaim(task.bidId, worker);
  await prisma.makerComputer.updateMany({ where: { worker }, data: { seenAt: new Date() } });
}

/** What the computer's browser reports: which AI sites are signed in, and why it waits (if it does). */
export async function reportStatus(worker: string, status: { sites?: Record<string, string>; note?: string | null }): Promise<void> {
  await prisma.makerComputer.updateMany({
    where: { worker },
    data: {
      seenAt: new Date(),
      status: { sites: status.sites ?? {}, note: status.note ?? null, at: new Date().toISOString() } as PrismaTypes.InputJsonValue,
    },
  });
}
