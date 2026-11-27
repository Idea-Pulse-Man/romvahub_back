import type { Actor } from '../auth/actor.js';
import { bidAccessScope } from '../bids/bids.service.js';
import { Prisma as PrismaTypes } from '../generated/prisma/client.js';
import { ConflictError, NotFoundError } from '../http/errors.js';
import { logger } from '../logger.js';
import { prisma } from '../prisma.js';
import { cancelMakeRequest, claimNext, completeClaim, releaseClaim, touchClaim } from '../local/auto-make-queue.js';
import { reportWorker } from '../local/auto-make-state.js';
import { computerFor } from '../local/maker-computers.js';
import {
  checkResumeAnswer,
  coverLetterMessageFromStoredResume,
  finishCoverLetter,
  finishResume,
  prepareMake,
  type MakeJob,
} from '../local/make-steps.js';
import { PromptsMissingError, type MakeMethod } from '../profiles/profile-prompts.service.js';
import { draftMarks, FINISHED_TEXT, INVALID_JSON, JSON_ONLY, jsonIn, nameSkillGroups, withDraftsPointedOut } from './texts.js';

/**
 * The make engine: the steps of making one application's Resume and cover
 * letter, run here on the server. The browser of the computer that was started
 * (the Romva Apply extension) only does what each task says — ask this AI this
 * — and hands the answer back. So the steps, the checks and the second tries
 * are the same on every computer, and change with a server update.
 *
 *   one step:   resume (ai: the Resume prompt) → letter (letterAi)
 *   two steps:  draft (draftAi: Step 1's prompt — the information the Resume needs, as JSON)
 *               → resume (ai: Step 2's prompt, with Step 1's answer) → letter (letterAi)
 *
 * A Resume answer that is incomplete (romva.space's check) or a draft
 * ("[Confirm…]", "X%", an unnamed skill group) is asked for once more, with
 * the problems spelled out. Step 1's answer that is not JSON is asked for once
 * more, then the application fails: Step 2's prompt is written for Step 1's
 * answer, so there is no going on without it. A Profile without the prompts of
 * the computer's method stops that computer, saying why, rather than failing
 * its applications one by one. The application is held in the shared queue the
 * whole time, so no other computer makes it.
 */

export type Site = 'chatgpt' | 'deepseek' | 'claude' | 'gemini';
type Step = 'draft' | 'resume' | 'letter';

export interface Choices {
  method: MakeMethod;
  /** One step: the Resume's AI. Two steps: Step 2's (the Resume). */
  ai: Site;
  /** Two steps: Step 1's AI (the information the Resume needs). */
  draftAi: Site;
  letterAi: Site;
  /** Each AI's settings (older Start windows kept one set per AI). */
  models: Record<string, Record<string, string | boolean>>;
  /** Each line's own settings for its AI — Step 1 (`draft`), the Resume, the cover letter: these win over `models`. */
  parts?: {
    draft?: Record<string, string | boolean>;
    resume?: Record<string, string | boolean>;
    letter?: Record<string, string | boolean>;
  };
}

/** The default (the user's choice, 2026-11-26): one step, ChatGPT · Chat · GPT-6 · High, the letter the same. */
export const DEFAULT_CHOICES: Choices = {
  method: 'one',
  ai: 'chatgpt',
  draftAi: 'deepseek',
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

/** What a task carries on to the application's next step. */
interface TaskContext {
  /** The method the application was started with (a change in the Start window counts from the next application). */
  method?: MakeMethod;
  /** Two steps: Step 1's answer (JSON), which Step 2's request carries. */
  stepOne?: string | null;
  /** The Resume's first answer, kept when it is asked for again: built after all when the second one cannot be. */
  firstAnswer?: string;
}

/** The step, as the browser's log and the dashboard show it. */
function stepLabel(step: Step, method: MakeMethod): string {
  if (step === 'draft') return 'Step 1 of 2 · information';
  if (step === 'letter') return 'Cover letter';
  return method === 'two' ? 'Step 2 of 2 · Resume' : 'Resume';
}

export interface TaskForBrowser {
  id: string;
  bidId: string;
  step: Step;
  site: Site;
  message: string;
  options: { webSearch: boolean; temporary: boolean; choice: Record<string, string | boolean> };
  attempt: number;
  /** The step in words: "Step 1 of 2 · information", "Step 2 of 2 · Resume", "Resume", "Cover letter". */
  label: string;
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
    draftAi: site(saved.draftAi, DEFAULT_CHOICES.draftAi),
    letterAi: site(saved.letterAi, site(saved.ai, DEFAULT_CHOICES.letterAi)),
    models: { ...DEFAULT_CHOICES.models, ...(saved.models ?? {}) },
    ...(saved.parts && typeof saved.parts === 'object' ? { parts: saved.parts } : {}),
  };
}

/** The settings a step asks its AI with: its line's own (Step 1 / the Resume / the cover letter), else that AI's. */
function settingsFor(choices: Choices, step: Step, site: Site): Record<string, string | boolean> {
  return { ...(choices.models[site] ?? {}), ...(choices.parts?.[step] ?? {}) };
}

/** The method of a task's application: as it was started (older tasks: the computer's choice now). */
function methodOf(context: TaskContext, choices: Choices): MakeMethod {
  return context.method === 'two' || context.method === 'one' ? context.method : choices.method;
}

async function toBrowser(task: {
  id: string;
  bidId: string;
  step: string;
  site: string;
  message: string;
  options: unknown;
  attempt: number;
  context?: unknown;
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
    label: stepLabel(task.step as Step, ((task.context ?? {}) as TaskContext).method === 'two' ? 'two' : 'one'),
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
  { attempt = 1, context = {} as TaskContext }: { attempt?: number; context?: TaskContext } = {},
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
        // Web search for the Resume and Step 1 (ChatGPT turns it on in the chat); every chat is a temporary one.
        webSearch: step !== 'letter',
        temporary: true,
        choice: settingsFor(choices, step, site),
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

/**
 * The computer stops (Start in a Start window is needed again), saying why: kept
 * on it, for the Start windows to show, until it is started or stopped there.
 */
async function stopComputer(worker: string, reason: string): Promise<void> {
  await prisma.makerComputer.updateMany({
    where: { worker },
    data: { running: false, status: { note: reason, stopped: true, at: new Date().toISOString() } as PrismaTypes.InputJsonValue },
  });
  logger.info({ worker, reason }, 'Maker: computer stopped');
}

/**
 * An application whose next step cannot even be prepared. Its Profile lacking
 * the prompts of this computer's method (PromptsMissingError) is not the
 * application's fault: it goes back uncounted, its Make request is dropped
 * (Make again once the prompts are there), and the computer stops — the
 * reason is returned, for the browser's log. Anything else counts as a failure.
 */
async function cannotPrepare(worker: string, bidId: string, error: unknown, prefix = ''): Promise<string | null> {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof PromptsMissingError) {
    await giveUp(bidId, worker, reason, false);
    await cancelMakeRequest(bidId).catch(() => undefined);
    await stopComputer(worker, reason);
    return reason;
  }
  await giveUp(bidId, worker, `${prefix}${reason}`, true);
  return null;
}

/** The application being made, for the next step — null when it cannot be (given up, or the computer stopped). */
async function jobFor(
  actor: Actor,
  worker: string,
  bidId: string,
  options: { method: MakeMethod; stepOne?: string | null },
  prefix = '',
): Promise<MakeJob | null> {
  try {
    return await prepareMake(actor, bidId, options);
  } catch (error) {
    await cannotPrepare(worker, bidId, error, prefix);
    return null;
  }
}

/** The first task of a new application for this computer — `started: false` when there is none to make (`notice`: why the computer stopped). */
async function startNext(actor: Actor, worker: string): Promise<{ started: boolean; notice?: string }> {
  let computer = await computerFor(worker);
  if (!computer) return { started: false }; // never started with the Start window: nothing for it
  // A Profile token works for its own Profile only: that one wins over the Start window's choice
  // (whose start No. counted in another Profile's numbers).
  if (actor.profileId && computer.profileId !== actor.profileId) {
    computer = { ...computer, profileId: actor.profileId, startFrom: null };
  }
  for (let tries = 0; tries < 3; tries += 1) {
    // At Stop only what someone asked for with "Make" is made.
    const claimed = await claimNext(bidAccessScope(actor), worker, { kind: 'any', requestedOnly: !computer.running, computer });
    if (!claimed) return { started: false };
    try {
      const choices = await choicesFor(worker);
      const job = await prepareMake(actor, claimed.id, { method: choices.method });
      await reportWorker({ current: { bidId: claimed.id, company: claimed.company }, waitingReason: null });
      const context: TaskContext = { method: choices.method };
      if (claimed.letterOnly) {
        await addTask(actor, worker, claimed.id, 'letter', choices.letterAi, await coverLetterMessageFromStoredResume(job), { context });
      } else if (choices.method === 'two' && job.step1Message) {
        await addTask(actor, worker, claimed.id, 'draft', choices.draftAi, `${job.step1Message}\n\n${JSON_ONLY}`, { context });
      } else {
        await addTask(actor, worker, claimed.id, 'resume', choices.ai, `${job.resumeMessage}\n\n${FINISHED_TEXT}`, { context });
      }
      logger.info({ bidId: claimed.id, worker, letterOnly: claimed.letterOnly, method: choices.method }, 'Maker: started an application');
      return { started: true };
    } catch (error) {
      const stopped = await cannotPrepare(worker, claimed.id, error, claimed.letterOnly ? 'Cover letter: ' : '');
      if (stopped) return { started: false, notice: stopped };
    }
  }
  return { started: false };
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
 * `task: null` when there is nothing to do; `notice`, while the engine has
 * stopped the computer (a Profile without its prompts), says why — for the
 * browser's log.
 */
export async function nextTask(actor: Actor, worker: string): Promise<{ task: TaskForBrowser | null; notice?: string }> {
  await prune().catch(() => undefined);
  // Whose token this computer's Romva Apply has: the Start windows offer only that Profile.
  const seen = await prisma.makerComputer
    .update({
      where: { worker },
      data: { seenAt: new Date(), tokenProfileId: actor.profileId ?? null },
      select: { running: true, status: true },
    })
    .catch(() => null);
  // Asking for work means it is not waiting any more (Romva Apply does not ask while paused): its last
  // "waiting" note ("The AI tab was closed", a signed-out site) goes, so the website's (!) does not stay.
  // Why the engine stopped it stays, for the Start windows, until it is started or stopped there.
  const status = seen?.status as { stopped?: unknown; note?: unknown } | null | undefined;
  const stopNote = !seen?.running && status?.stopped === true ? String(status.note ?? '') || undefined : undefined;
  if (status && !stopNote) {
    await prisma.makerComputer.updateMany({ where: { worker }, data: { status: PrismaTypes.DbNull } }).catch(() => undefined);
  }
  // Given out too long ago: the page hung or the browser was closed.
  const stale = await prisma.makerTask.findMany({
    where: { worker, status: 'taken', takenAt: { lt: new Date(Date.now() - TASK_TIMEOUT_MS) } },
    select: { bidId: true },
  });
  for (const task of stale) await giveUp(task.bidId, worker, 'The AI page did not answer in time.', true);

  const held = await prisma.makerTask.findFirst({ where: { worker, status: 'taken' }, orderBy: { createdAt: 'asc' } });
  if (held) return { task: await toBrowser(held) };

  for (let round = 0; round < 2; round += 1) {
    const waiting = await prisma.makerTask.findFirst({ where: { worker, status: 'waiting' }, orderBy: { createdAt: 'asc' } });
    if (waiting) {
      const taken = await prisma.makerTask.updateMany({
        where: { id: waiting.id, status: 'waiting' },
        data: { status: 'taken', takenAt: new Date() },
      });
      if (taken.count === 1) {
        await touchClaim(waiting.bidId, worker);
        return { task: await toBrowser(waiting) };
      }
      continue;
    }
    if (round === 0) {
      const next = await startNext(actor, worker);
      // Stopped (now, or before): why, each time — the browser logs it once.
      const notice = next.notice ?? stopNote;
      if (!next.started) return { task: null, ...(notice ? { notice } : {}) };
    }
  }
  return { task: null };
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
  const context = (task.context ?? {}) as TaskContext;
  const choices = await choicesFor(worker);
  const method = methodOf(context, choices);

  if (task.step === 'draft') {
    // Step 1's answer: the information for this Resume, as JSON — Step 2's request carries it.
    const stepOne = jsonIn(answer);
    const job = await jobFor(actor, worker, task.bidId, { method: 'two', stepOne }, 'Step 1: ');
    if (!job) return;
    if (stepOne) {
      await addTask(actor, worker, task.bidId, 'resume', choices.ai, `${job.resumeMessage}\n\n${FINISHED_TEXT}`, {
        context: { method: 'two', stepOne },
      });
    } else if (task.attempt < 2 && job.step1Message) {
      await addTask(actor, worker, task.bidId, 'draft', task.site as Site, `${job.step1Message}\n\n${INVALID_JSON}`, {
        attempt: 2,
        context: { method: 'two' },
      });
    } else {
      await giveUp(task.bidId, worker, 'Step 1: the answer was not JSON (asked twice).', true);
    }
    return;
  }

  const job = await jobFor(actor, worker, task.bidId, { method, stepOne: context.stepOne ?? null }, task.step === 'letter' ? 'Cover letter: ' : '');
  if (!job) return;

  if (task.step === 'resume') {
    const { text, unnamed } = nameSkillGroups(answer);
    const check = await checkResumeAnswer(job, text);
    const marks = [...draftMarks(text), ...unnamed.map((name) => `a skill group named "${name}" instead of its own name`)];
    if ((check.problems.length || marks.length) && task.attempt < 2) {
      let retry = check.problems.length && check.retryMessage ? check.retryMessage : job.resumeMessage;
      if (marks.length) retry = withDraftsPointedOut(retry, marks);
      // The retry holds the whole request — in two steps, Step 1's answer with it.
      await addTask(actor, worker, task.bidId, 'resume', task.site as Site, `${retry}\n\n${FINISHED_TEXT}`, {
        attempt: 2,
        // The first answer, kept: built after all when the second one cannot be (not JSON, "I can do that…").
        context: { ...context, method, firstAnswer: text },
      });
      logger.info({ bidId: task.bidId, problems: check.problems, marks }, 'Maker: Resume asked for again');
      return;
    }
    let letterMessage: string;
    try {
      letterMessage = (await finishResume(job, text)).coverLetterMessage;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // The second answer could not be built: the first one is, when it can be (it only lacked some bullets…).
      const first = typeof context.firstAnswer === 'string' ? context.firstAnswer : null;
      try {
        if (!first) throw error;
        letterMessage = (await finishResume(job, first)).coverLetterMessage;
        logger.info({ bidId: task.bidId, reason }, 'Maker: the second Resume answer could not be used; the first one was built');
      } catch {
        await giveUp(task.bidId, worker, reason, true);
        return;
      }
    }
    await addTask(actor, worker, task.bidId, 'letter', choices.letterAi, letterMessage, { context: { method } });
    return;
  }

  // The cover letter.
  try {
    await finishCoverLetter(job, answer);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (task.attempt < 2) {
      await addTask(actor, worker, task.bidId, 'letter', task.site as Site, task.message, { attempt: 2, context: { method } });
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
 * out, busy, its limit): not the application's fault — it is handed back
 * uncounted, and the computer waits. Otherwise the step is tried once more,
 * then the application counts as failed (Step 1 too: Step 2 needs its answer).
 */
export async function failTask(
  actor: Actor,
  worker: string,
  taskId: string,
  { reason, unavailable }: { reason: string; unavailable: boolean },
): Promise<void> {
  const task = await ownTask(worker, taskId);
  await prisma.makerTask.update({ where: { id: task.id }, data: { status: 'failed', error: reason.slice(0, 4000), doneAt: new Date() } });
  if (unavailable) {
    await giveUp(task.bidId, worker, reason, false);
    await reportWorker({ waitingReason: reason.slice(0, 2000) });
    return;
  }
  if (task.attempt < 2) {
    await addTask(actor, worker, task.bidId, task.step as Step, task.site as Site, task.message, {
      attempt: 2,
      context: (task.context ?? {}) as TaskContext,
    });
    return;
  }
  const prefix = task.step === 'letter' ? 'Cover letter: ' : task.step === 'draft' ? 'Step 1: ' : '';
  await giveUp(task.bidId, worker, `${prefix}${reason}`, true);
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
      status: { sites: status.sites ?? {}, note: status.note ?? null, stopped: false, at: new Date().toISOString() } as PrismaTypes.InputJsonValue,
    },
  });
}
