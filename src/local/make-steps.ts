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
import { parseJsonAnswer } from './json-answer.js';

/**
 * One application's Resume and cover letter, as four steps around the two
 * ChatGPT chats:
 *
 *   prepareMake → (ChatGPT: job.resumeMessage) → finishResume
 *               → (ChatGPT: coverLetterMessage) → finishCoverLetter
 *
 * Split so that whoever talks to ChatGPT can be somewhere else: the local API
 * (`chatgpt-resume.ts`, its own Chrome window), the Chrome extension or the
 * desktop agent (through `/api/auto-make/jobs/...`, from any computer). The
 * server side — prompts, the Word template, PDF, storing the files — is the
 * same for all of them. No step keeps state between calls: each one reads
 * what it needs from the application again.
 */

export interface MadeFile {
  name: string;
  /** Base64 of the bytes, for the caller to write to disk. */
  base64: string;
}

export interface MakeJob {
  bid: Bid;
  actor: Actor;
  /** The account the application belongs to: its profile and prompts. */
  ownerUserId: string;
  /** The posting as Markdown — what ChatGPT reads and the .txt file holds. */
  jobDescription: string;
  prompts: Awaited<ReturnType<typeof settingsForMake>>;
  profile: Awaited<ReturnType<typeof profileService.getProfile>>;
  /** `Jonathan_Bai_Latent_AI` — the start of every file name. */
  stem: string;
  /** The Profile's folder under the save folder, e.g. `Jonathan_Bai`. */
  profileFolderName: string;
  /** The application's folder inside it, e.g. `Latent_Ai_Ai_Engineer`. */
  folderName: string;
  /** The first chat's message: the Profile's Resume prompt and the posting. */
  resumeMessage: string;
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
export function fileStem(...parts: string[]): string {
  return parts
    .join(' ')
    .replace(UNSAFE, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join('_')
    .replace(/[._]+$/, '');
}

/** Everything the two chats need, read from the application, its Profile and the Profile's prompts. */
export async function prepareMake(actor: Actor, bidId: string): Promise<MakeJob> {
  const bid = await bidsService.getBid(actor, bidId);
  if (bid.status === 'Skip') {
    throw new BadRequestError('This application is marked Skip, so no Resume or cover letter is made for it.');
  }
  const description = bid.jobDescription?.trim();
  if (!description) {
    throw new BadRequestError('This application has no job description. Add one, then click Make again.');
  }
  const jobDescription = toMarkdown(description).markdown || description;

  const ownerUserId = bid.candidate?.userId ?? actor.id;
  const profile = bid.candidate?.profileId
    ? await profileService.getProfileById(bid.candidate.profileId)
    : await profileService.getProfile(ownerUserId);
  // The Profile's own Resume prompt and template (Profiles → Prompts &
  // Template) are required: no ChatGPT call for a Profile missing either. The
  // cover letter prompt falls back to the simple one.
  const prompts = await settingsForMake({ profileId: bid.candidate?.profileId, ownerUserId });

  const firstName = profile.firstName || bid.candidate?.firstName || '';
  const lastName = profile.lastName || bid.candidate?.lastName || '';

  const input = JSON.stringify(
    { target_company: bid.company, target_role: bid.role, job_description: jobDescription },
    null,
    2,
  );
  const resumeMessage = [
    prompts.resumePrompt,
    '',
    '================================================================================',
    'INPUT',
    '================================================================================',
    input,
    '',
    'Reply with the JSON only, in a single ```json code block.',
  ].join('\n');

  return {
    bid,
    actor,
    ownerUserId,
    jobDescription,
    prompts,
    profile,
    stem: fileStem(firstName, lastName, bid.company) || 'Resume',
    profileFolderName: fileStem(firstName, lastName) || 'Profile',
    folderName: applicationFolderName(bid.company, bid.role),
    resumeMessage,
  };
}

export interface FinishedResume {
  bid: Bid;
  /** ChatGPT's Resume JSON, which the cover letter is written from. */
  resume: unknown;
  files: { pdf: MadeFile; docx: MadeFile; jobDescription: MadeFile };
  /** The second chat's message, built from this Resume. */
  coverLetterMessage: string;
}

/** ChatGPT's first answer → the Resume in the Profile's Word template, as Word and PDF, stored on the application. */
export async function finishResume(job: MakeJob, answer: string): Promise<FinishedResume> {
  const json = parseJsonAnswer(answer);

  // The app's own prompt answers in its structured shape; a Resume Maker
  // prompt (P.txt) in Maker JSON. Both go into the same Word template.
  const templateId = job.prompts.templateId;
  const name = [job.profile.firstName, job.profile.lastName].filter(Boolean).join(' ').trim();
  const structured = AiResumeSchema.safeParse(json);
  let docx: Buffer;
  try {
    docx = structured.success
      ? (
          await renderStructuredWithMaker({
            document: structured.data,
            format: 'docx',
            name: name || undefined,
            fallbackCompanies: job.profile.workExperience.map((entry) => entry.company),
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

  const pdfName = `${job.stem}_resume.pdf`;
  const docxName = `${job.stem}_resume.docx`;
  const bid = await bidsService.replaceResumeFiles(job.actor, job.bid.id, [
    { format: 'pdf', name: pdfName, contentType: 'application/pdf', data: pdf },
    {
      format: 'docx',
      name: docxName,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: docx,
    },
  ]);

  return {
    bid,
    resume: json,
    files: {
      pdf: { name: pdfName, base64: pdf.toString('base64') },
      docx: { name: docxName, base64: docx.toString('base64') },
      jobDescription: {
        name: `${job.stem}_job_description.txt`,
        base64: Buffer.from(job.jobDescription, 'utf8').toString('base64'),
      },
    },
    coverLetterMessage: coverLetterMessage(job, json),
  };
}

/** The JSON shape the letter template needs — asked for whatever the Profile's prompt says. */
const COVER_LETTER_SHAPE = `Reply with JSON only, in a single json code block, exactly in this shape:
{"company": "<company>", "role": "<role>", "greeting": "Dear Hiring Manager,", "paragraphs": ["<paragraph 1>", "<paragraph 2>", "<paragraph 3>"], "closing": "Sincerely,"}`;

/** The second chat: the Profile's cover letter prompt, the posting and the Resume just made. */
export function coverLetterMessage(job: MakeJob, resume: unknown): string {
  // The Resume as ChatGPT wrote it, minus the posting it already echoes and
  // the template's highlight markup.
  const copy = { ...(resume as Record<string, unknown>) };
  delete copy.job_description;
  delete copy.jobDescription;
  const resumeText = JSON.stringify(copy, null, 2).replace(/\[([^\]]+)\]\[highlight\]/gi, '$1');

  return [
    job.prompts.coverLetterPrompt,
    '',
    COVER_LETTER_SHAPE,
    '',
    `COMPANY: ${job.bid.company}`,
    `ROLE: ${job.bid.role}`,
    '',
    'JOB DESCRIPTION:',
    job.jobDescription,
    '',
    'MY RESUME (JSON):',
    resumeText,
  ].join('\n');
}

export interface FinishedCoverLetter {
  bid: Bid;
  files: { coverLetterPdf: MadeFile; coverLetterDocx: MadeFile };
}

/** ChatGPT's second answer → the letter as PDF and Word, stored on the application. */
export async function finishCoverLetter(job: MakeJob, answer: string): Promise<FinishedCoverLetter> {
  const letter = toCoverLetter(parseJsonAnswer(answer), job.bid);
  const [letterPdf, letterDocx] = await Promise.all(
    (['pdf', 'docx'] as const).map((format) =>
      renderCoverLetter(
        job.ownerUserId,
        { document: letter, format },
        { date: job.bid.bidDate, profileId: job.bid.candidate?.profileId },
      ),
    ),
  );
  const bid = await bidsService.setBidCoverLetter(job.actor, job.bid.id, letter);
  return {
    bid,
    files: {
      coverLetterPdf: { name: `${job.stem}_cover_letter.pdf`, base64: letterPdf!.file.toString('base64') },
      coverLetterDocx: { name: `${job.stem}_cover_letter.docx`, base64: letterDocx!.file.toString('base64') },
    },
  };
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
