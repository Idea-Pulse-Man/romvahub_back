import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Actor } from '../auth/actor.js';
import type { Bid } from '../domain/types.js';
import { logger } from '../logger.js';
import { askChatGpt } from './chatgpt-web.js';
import { autoMakeEnabled } from './auto-make-state.js';
import {
  checkResumeAnswer,
  coverLetterMessageFromStoredResume,
  finishCoverLetter,
  finishResume,
  prepareMake,
  type MadeFile,
} from './make-steps.js';

/**
 * The Applications table's "Make": one application's Resume written by
 * ChatGPT (chatgpt.com in a local Chrome window, see `chatgpt-web.ts`), laid
 * out in the profile's Word template, and stored on the application — the
 * same files the folder sync would have uploaded. The browser then writes
 * them into the Resume save folder, which it alone can reach.
 *
 * The prompts are the Profile's own (Profiles → Prompts, editable by an admin
 * and the Users it is shared with), else the defaults — see
 * `profiles/profile-prompts.service.ts`.
 *
 * A short cover letter follows in a second chat, written from the posting and
 * the Resume just made, stored on the application and rendered to PDF and
 * Word — so the folder ends up with five files, under the Profile's folder:
 *
 *   <save folder>/Jonathan_Bai/Latent_Ai_Ai_Engineer/
 *     job description (.txt), Resume (.pdf, .docx), cover letter (.pdf, .docx)
 */

export type { MadeFile } from './make-steps.js';
export { applicationFolderName } from './make-steps.js';

export interface MadeResume {
  bid: Bid;
  /** The Profile's folder under the save folder, e.g. `Jonathan_Bai`. */
  profileFolderName: string;
  /** The application's folder inside it, named as the Resume Builder names it. */
  folderName: string;
  /** The five files of the folder; the cover letter's two are absent when it failed. */
  files: {
    pdf: MadeFile;
    docx: MadeFile;
    jobDescription: MadeFile;
    coverLetterPdf?: MadeFile;
    coverLetterDocx?: MadeFile;
  };
  /** Why the cover letter could not be made, when the Resume was. */
  coverLetterError?: string;
  /** Where the API wrote the files itself (RESUME_SAVE_DIR set); the page then writes nothing. */
  savedTo?: string;
  /** Why the API could not write them there. */
  saveError?: string;
}

/** Makes in flight, by application: a click during an automatic Make joins it rather than asking twice. */
const inFlight = new Map<string, Promise<MadeResume>>();

export function makeResumeWithChatGpt(actor: Actor, bidId: string): Promise<MadeResume> {
  const running = inFlight.get(bidId);
  if (running) return running;
  const run = make(actor, bidId).finally(() => inFlight.delete(bidId));
  inFlight.set(bidId, run);
  return run;
}

/** The applications being made right now — for the table to show "Making…". */
export function makingNow(): string[] {
  return [...inFlight.keys()];
}

/**
 * Automatic Make for a newly added application, when CHATGPT_AUTO_MAKE=true:
 * started in the background, so saving the application is not held up by
 * ChatGPT. Queued behind any other Make (one ChatGPT window, one chat at a
 * time). Failures are logged; the row keeps its Make button for a retry.
 */
export function autoMakeNewApplication(actor: Actor, bid: Bid): void {
  if (process.env.CHATGPT_AUTO_MAKE?.trim().toLowerCase() !== 'true') return;
  if (bid.status === 'Skip' || !bid.jobDescription?.trim()) return;
  // Stopped on romva.space: leave it; the watcher picks it up after Start.
  void autoMakeEnabled()
    .then((enabled) => (enabled ? makeResumeWithChatGpt(actor, bid.id) : null))
    .then(
      (made) => {
        if (!made) return;
        logger.info(
          { bidId: bid.id, savedTo: made.savedTo, saveError: made.saveError, coverLetterError: made.coverLetterError },
          'Auto Make finished',
        );
      },
      (error) => logger.error({ err: error, bidId: bid.id }, 'Auto Make failed'),
    );
}

/** The two chats in this computer's ChatGPT window, around the shared steps (`make-steps.ts`). */
async function make(actor: Actor, bidId: string): Promise<MadeResume> {
  const job = await prepareMake(actor, bidId);
  // The answer is looked over first: missing a summary, the skills or a job's
  // title, ChatGPT is asked once more, told what was missing.
  let answer = await askChatGpt(job.resumeMessage);
  const check = await checkResumeAnswer(job, answer);
  if (check.retryMessage) {
    logger.warn({ bidId, problems: check.problems }, 'Resume answer incomplete; asking ChatGPT again');
    answer = await askChatGpt(check.retryMessage);
  }
  const resume = await finishResume(job, answer);
  let bid = resume.bid;
  const files: MadeResume['files'] = { ...resume.files };

  // The cover letter is the second half: written from the Resume just made. A
  // failure here keeps the Resume; it is tried once more (a slow page load is
  // the usual cause), then reported rather than thrown.
  let coverLetterError: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const letter = await finishCoverLetter(job, await askChatGpt(resume.coverLetterMessage));
      bid = letter.bid;
      Object.assign(files, letter.files);
      coverLetterError = undefined;
      break;
    } catch (error) {
      coverLetterError = error instanceof Error ? error.message : String(error);
      logger.warn({ bidId, attempt, reason: coverLetterError }, 'Cover letter failed');
    }
  }

  // With RESUME_SAVE_DIR set, the API writes the files itself — what lets a
  // Make nobody clicked (a new application from the form or the scraper
  // extension) still land on disk. Without it, the page that clicked Make
  // writes them through its folder handle.
  let savedTo: string | undefined;
  let saveError: string | undefined;
  const saveRoot = resumeSaveDir();
  if (saveRoot) {
    const directory = path.win32.join(saveRoot, job.profileFolderName, job.folderName);
    try {
      await mkdir(directory, { recursive: true });
      for (const file of Object.values(files)) {
        if (file) await writeFile(path.win32.join(directory, file.name), Buffer.from(file.base64, 'base64'));
      }
      savedTo = directory;
    } catch (error) {
      saveError = `Could not write to ${directory}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    bid,
    profileFolderName: job.profileFolderName,
    folderName: job.folderName,
    files,
    ...(coverLetterError ? { coverLetterError } : {}),
    ...(savedTo ? { savedTo } : {}),
    ...(saveError ? { saveError } : {}),
  };
}

/**
 * Just the cover letter, for an application whose Resume is stored but whose
 * letter failed: written from the stored Resume's text, then saved next to
 * the Resume in the save folder.
 */
export async function makeCoverLetterOnly(actor: Actor, bidId: string): Promise<{ savedTo?: string }> {
  const job = await prepareMake(actor, bidId);
  const letter = await finishCoverLetter(job, await askChatGpt(await coverLetterMessageFromStoredResume(job)));
  const saveRoot = resumeSaveDir();
  if (!saveRoot) return {};
  const directory = path.win32.join(saveRoot, job.profileFolderName, job.folderName);
  await mkdir(directory, { recursive: true });
  for (const file of Object.values(letter.files)) {
    await writeFile(path.win32.join(directory, file.name), Buffer.from(file.base64, 'base64'));
  }
  return { savedTo: directory };
}

/** The Resume save folder the API writes into itself (`RESUME_SAVE_DIR`), when one is set. */
export function resumeSaveDir(): string | null {
  const directory = process.env.RESUME_SAVE_DIR?.trim();
  return directory && path.win32.isAbsolute(directory) ? directory : null;
}
