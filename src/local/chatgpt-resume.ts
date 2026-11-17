import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Actor } from '../auth/actor.js';
import * as bidsService from '../bids/bids.service.js';
import type { Bid } from '../domain/types.js';
import { BadGatewayError, BadRequestError } from '../http/errors.js';
import { toMarkdown } from '../jobs/markdown.js';
import * as profileService from '../profile/profile.service.js';
import { convertDocxToPdf, processMakerJson, renderStructuredWithMaker } from '../resume/maker/maker.service.js';
import { AiResumeSchema } from '../resume/resume.schemas.js';
import { CoverLetterPayloadSchema, type CoverLetterPayload } from '../cover-letter/cover-letter.schemas.js';
import { renderCoverLetter } from '../cover-letter/cover-letter.service.js';
import { settingsForMake } from '../profiles/profile-prompts.service.js';
import { logger } from '../logger.js';
import { askChatGpt, parseJsonAnswer } from './chatgpt-web.js';
import { autoMakeEnabled } from './auto-make-state.js';

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

export interface MadeFile {
  name: string;
  /** Base64 of the bytes, for the browser to write to disk. */
  base64: string;
}

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

const UNSAFE = /[\\/:*?"<>|#%]+/g;

/** "Latent AI", "AI Engineer" → "Latent_Ai_Ai_Engineer" — the Resume Builder's folder names. */
export function applicationFolderName(company: string, role: string): string {
  return (
    `${company} ${role}`
      .replace(UNSAFE, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('_')
      .replace(/[. ]+$/, '') || 'Application'
  );
}

/** "Jonathan", "Bai", "Latent AI" → "Jonathan_Bai_Latent_AI" — the Resume Builder's file stems. */
function fileStem(...parts: string[]): string {
  return parts
    .join(' ')
    .replace(UNSAFE, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join('_')
    .replace(/[._]+$/, '');
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

async function make(actor: Actor, bidId: string): Promise<MadeResume> {
  const bid = await bidsService.getBid(actor, bidId);
  if (bid.status === 'Skip') {
    throw new BadRequestError('This application is marked Skip, so no Resume or cover letter is made for it.');
  }
  const description = bid.jobDescription?.trim();
  if (!description) {
    throw new BadRequestError('This application has no job description. Add one, then click Make again.');
  }
  const jobDescription = toMarkdown(description).markdown || description;

  const ownerId = bid.candidate?.userId ?? actor.id;
  const profile = bid.candidate?.profileId
    ? await profileService.getProfileById(bid.candidate.profileId)
    : await profileService.getProfile(ownerId);
  // The Profile's own Resume prompt and template (Profiles → Prompts &
  // Template) are required: no ChatGPT call for a Profile missing either. The
  // cover letter prompt falls back to the simple one.
  const prompts = await settingsForMake({ profileId: bid.candidate?.profileId, ownerUserId: ownerId });

  const input = JSON.stringify(
    { target_company: bid.company, target_role: bid.role, job_description: jobDescription },
    null,
    2,
  );
  const message = [
    prompts.resumePrompt,
    '',
    '================================================================================',
    'INPUT',
    '================================================================================',
    input,
    '',
    'Reply with the JSON only, in a single ```json code block.',
  ].join('\n');

  const json = parseJsonAnswer(await askChatGpt(message));

  // The app's own prompt answers in its structured shape; a Resume Maker
  // prompt (P.txt) in Maker JSON. Both go into the same Word template.
  const templateId = prompts.templateId;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
  const structured = AiResumeSchema.safeParse(json);
  let docx: Buffer;
  try {
    docx = structured.success
      ? (
          await renderStructuredWithMaker({
            document: structured.data,
            format: 'docx',
            name: name || undefined,
            fallbackCompanies: profile.workExperience.map((entry) => entry.company),
            templateId,
          })
        ).file
      : (await processMakerJson({ json: json as object, format: 'docx', templateId })).file;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The database dropping out is not the answer's fault: passed on as it is.
    if (/Connection terminated|ECONNRESET|ETIMEDOUT|connection timeout|Can't reach database/i.test(reason)) throw error;
    throw new BadGatewayError(`ChatGPT answered, but its JSON did not fit the Resume template: ${reason}`);
  }
  const pdf = await convertDocxToPdf(docx);

  const firstName = profile.firstName || bid.candidate?.firstName || '';
  const lastName = profile.lastName || bid.candidate?.lastName || '';
  const stem = fileStem(firstName, lastName, bid.company) || 'Resume';
  const pdfName = `${stem}_resume.pdf`;
  const docxName = `${stem}_resume.docx`;

  let updated = await bidsService.replaceResumeFiles(actor, bid.id, [
    { format: 'pdf', name: pdfName, contentType: 'application/pdf', data: pdf },
    {
      format: 'docx',
      name: docxName,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: docx,
    },
  ]);

  const files: MadeResume['files'] = {
    pdf: { name: pdfName, base64: pdf.toString('base64') },
    docx: { name: docxName, base64: docx.toString('base64') },
    jobDescription: {
      name: `${stem}_job_description.txt`,
      base64: Buffer.from(jobDescription, 'utf8').toString('base64'),
    },
  };

  // The cover letter is the second half: written from the Resume just made.
  // A failure here keeps the Resume — it is reported, not thrown.
  let coverLetterError: string | undefined;
  try {
    const letter = await makeCoverLetter({
      bid,
      jobDescription,
      resume: json,
      instructions: prompts.coverLetterPrompt,
    });
    const ownerUserId = bid.candidate?.userId ?? actor.id;
    const [letterPdf, letterDocx] = await Promise.all(
      (['pdf', 'docx'] as const).map((format) =>
        renderCoverLetter(
          ownerUserId,
          { document: letter, format },
          { date: bid.bidDate, profileId: bid.candidate?.profileId },
        ),
      ),
    );
    updated = await bidsService.setBidCoverLetter(actor, bid.id, letter);
    files.coverLetterPdf = { name: `${stem}_cover_letter.pdf`, base64: letterPdf!.file.toString('base64') };
    files.coverLetterDocx = { name: `${stem}_cover_letter.docx`, base64: letterDocx!.file.toString('base64') };
  } catch (error) {
    coverLetterError = error instanceof Error ? error.message : String(error);
  }

  const profileFolderName = fileStem(firstName, lastName) || 'Profile';
  const folderName = applicationFolderName(bid.company, bid.role);

  // With RESUME_SAVE_DIR set, the API writes the files itself — what lets a
  // Make nobody clicked (a new application from the form or the scraper
  // extension) still land on disk. Without it, the page that clicked Make
  // writes them through its folder handle.
  let savedTo: string | undefined;
  let saveError: string | undefined;
  const saveRoot = resumeSaveDir();
  if (saveRoot) {
    const directory = path.win32.join(saveRoot, profileFolderName, folderName);
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
    bid: updated,
    profileFolderName,
    folderName,
    files,
    ...(coverLetterError ? { coverLetterError } : {}),
    ...(savedTo ? { savedTo } : {}),
    ...(saveError ? { saveError } : {}),
  };
}

/** The Resume save folder the API writes into itself (`RESUME_SAVE_DIR`), when one is set. */
export function resumeSaveDir(): string | null {
  const directory = process.env.RESUME_SAVE_DIR?.trim();
  return directory && path.win32.isAbsolute(directory) ? directory : null;
}

/** The JSON shape the letter template needs — asked for whatever the Profile's prompt says. */
const COVER_LETTER_SHAPE = `Reply with JSON only, in a single json code block, exactly in this shape:
{"company": "<company>", "role": "<role>", "greeting": "Dear Hiring Manager,", "paragraphs": ["<paragraph 1>", "<paragraph 2>", "<paragraph 3>"], "closing": "Sincerely,"}`;

async function makeCoverLetter(input: {
  bid: Bid;
  jobDescription: string;
  resume: unknown;
  instructions: string;
}): Promise<CoverLetterPayload> {
  // The Resume as ChatGPT wrote it, minus the posting it already echoes and
  // the template's highlight markup.
  const resume = { ...(input.resume as Record<string, unknown>) };
  delete resume.job_description;
  delete resume.jobDescription;
  const resumeText = JSON.stringify(resume, null, 2).replace(/\[([^\]]+)\]\[highlight\]/gi, '$1');

  const message = [
    input.instructions,
    '',
    COVER_LETTER_SHAPE,
    '',
    `COMPANY: ${input.bid.company}`,
    `ROLE: ${input.bid.role}`,
    '',
    'JOB DESCRIPTION:',
    input.jobDescription,
    '',
    'MY RESUME (JSON):',
    resumeText,
  ].join('\n');

  return toCoverLetter(parseJsonAnswer(await askChatGpt(message)), input.bid);
}

/** ChatGPT's answer as the letter template's payload, forgiving the usual near misses. */
function toCoverLetter(answer: unknown, bid: Bid): CoverLetterPayload {
  const parsed = CoverLetterPayloadSchema.safeParse(answer);
  if (parsed.success && parsed.data.paragraphs.length > 0) return parsed.data;

  const raw = (answer ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  let paragraphs = Array.isArray(raw.paragraphs) ? raw.paragraphs.map(text).filter(Boolean) : [];
  if (paragraphs.length === 0) {
    const body = text(raw.body) || text(raw.cover_letter) || text(raw.coverLetter) || text(raw.letter) || text(raw.text);
    paragraphs = body.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  }
  if (paragraphs.length === 0) {
    throw new BadGatewayError("ChatGPT's cover letter answer had no paragraphs.");
  }
  return {
    company: text(raw.company) || bid.company,
    role: text(raw.role) || bid.role,
    greeting: text(raw.greeting) || 'Dear Hiring Manager,',
    paragraphs,
    closing: text(raw.closing) || 'Sincerely,',
  };
}
