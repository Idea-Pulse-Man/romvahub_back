import type { Actor } from '../auth/actor.js';
import * as bidsService from '../bids/bids.service.js';
import type { Bid } from '../domain/types.js';
import { BadGatewayError, BadRequestError } from '../http/errors.js';
import { toMarkdown } from '../jobs/markdown.js';
import * as profileService from '../profile/profile.service.js';
import { convertDocxToPdf } from '../resume/maker/maker.service.js';
import { readTemplateBytes } from '../resume/maker/templates.js';
import { AiResumeSchema } from '../resume/resume.schemas.js';
import { CoverLetterPayloadSchema, type CoverLetterPayload } from '../cover-letter/cover-letter.schemas.js';
import { settingsForMake } from '../profiles/profile-prompts.service.js';
import mammoth from 'mammoth';
import { prisma } from '../prisma.js';
import { parseJsonAnswer } from './json-answer.js';
import { bulletsNamedIn, resumeAnswerProblems, resumeRetryMessage } from './resume-answer-check.js';
import { checkBidQuietly } from '../resume/resume-check.js';
import { applicationFolderName, fileStem } from '../resume/store/names.js';
import {
  buildResumeDocx,
  coverLetterFile,
  resumeFile,
  saveMadeResume,
  type ResumeBuild,
} from '../resume/store/resume-store.js';
import { keepTemplateVersion } from '../resume/store/template-versions.js';

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

export { applicationFolderName, fileStem } from '../resume/store/names.js';

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

function profileName(job: MakeJob): string {
  return [job.profile.firstName, job.profile.lastName].filter(Boolean).join(' ').trim();
}

/**
 * What is missing from a parsed Resume answer for this Profile's template (empty: it can be built).
 * `allBullets`: also each bullet point the prompt asks for (the check before asking again); the
 * build itself needs only one per job, so a second answer still short of some is built.
 */
function problemsIn(job: MakeJob, json: object, { allBullets = false } = {}): Promise<string[]> {
  return resumeAnswerProblems(json, {
    templateId: job.prompts.templateId,
    name: profileName(job) || undefined,
    fallbackCompanies: job.profile.workExperience.map((entry) => entry.company),
    ...(allBullets ? { requestedBullets: bulletsNamedIn(job.resumeMessage) } : {}),
  });
}

export interface ResumeAnswerCheck {
  /** What is wrong with the answer, in words; empty when the Resume can be built from it. */
  problems: string[];
  /** When something is wrong: the message for a second chat, the request with the problems spelled out. */
  retryMessage?: string;
}

/**
 * The step between ChatGPT's Resume answer and building the Resume: is the
 * JSON readable, and does it fill the template's summary, skills, job titles
 * and bullet points? Stores nothing and counts nothing — so a worker can ask
 * ChatGPT once more, with what was missing, before handing the answer in.
 */
export async function checkResumeAnswer(job: MakeJob, answer: string): Promise<ResumeAnswerCheck> {
  let json: unknown;
  try {
    json = parseJsonAnswer(answer);
  } catch (error) {
    const problems = [error instanceof Error ? error.message : 'the answer was not valid JSON'];
    return { problems, retryMessage: resumeRetryMessage(job.resumeMessage, problems, null) };
  }
  const problems = await problemsIn(job, json as object, { allBullets: true });
  return problems.length ? { problems, retryMessage: resumeRetryMessage(job.resumeMessage, problems, json) } : { problems };
}

/** ChatGPT's first answer → the Resume in the Profile's Word template, as Word and PDF, stored on the application. */
export async function finishResume(job: MakeJob, answer: string): Promise<FinishedResume> {
  const json = parseJsonAnswer(answer);

  // A Resume with an empty summary, no skills or a job without a title is
  // never stored: refused like an unreadable answer (and tried again later).
  const problems = await problemsIn(job, json as object);
  if (problems.length) {
    throw new BadGatewayError(`ChatGPT's Resume JSON is incomplete: ${problems.join('; ')}.`);
  }

  // The app's own prompt answers in its structured shape; a Resume Maker
  // prompt (P.txt) in Maker JSON. Both go into the same Word template. The
  // template version is kept, so this Resume can be built again exactly.
  const name = profileName(job);
  let build: ResumeBuild;
  let docx: Buffer;
  try {
    const template = await readTemplateBytes(job.prompts.templateId);
    const templateSha256 = await keepTemplateVersion(template);
    build = AiResumeSchema.safeParse(json).success
      ? {
          kind: 'structured',
          templateId: template.id,
          templateSha256,
          name: name || undefined,
          fallbackCompanies: job.profile.workExperience.map((entry) => entry.company),
          stem: job.stem,
        }
      : { kind: 'maker', templateId: template.id, templateSha256, stem: job.stem };
    docx = await buildResumeDocx(json, build);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The database dropping out is not the answer's fault: passed on as it is.
    if (/Connection terminated|ECONNRESET|ETIMEDOUT|connection timeout|Can't reach database/i.test(reason)) throw error;
    throw new BadGatewayError(`ChatGPT answered, but its JSON did not fit the Resume template: ${reason}`);
  }
  const pdf = await convertDocxToPdf(docx);

  const pdfName = `${job.stem}_resume.pdf`;
  const docxName = `${job.stem}_resume.docx`;
  // The JSON goes on the application; the Word and PDF files to the Resume folder.
  await saveMadeResume({ bidId: job.bid.id, answer: json, build, docx, pdf });
  const bid = await bidsService.getBid(job.actor, job.bid.id);
  // The Resume check, as it is saved: a bad one is flagged at once.
  await checkBidQuietly(job.bid.id);

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
  return letterMessage(job, 'MY RESUME (JSON):', resumeText);
}

/**
 * The second chat for an application whose Resume is already stored but whose
 * cover letter is missing (its letter failed after the Resume was made): the
 * Resume's text, read from the stored Word file, stands in for ChatGPT's JSON.
 */
export async function coverLetterMessageFromStoredResume(job: MakeJob): Promise<string> {
  // A Resume kept as JSON is the JSON the first chat wrote.
  const answer = await prisma.bid.findUnique({ where: { id: job.bid.id }, select: { resumeAnswer: true } });
  if (answer?.resumeAnswer) return coverLetterMessage(job, answer.resumeAnswer);
  const docx = await resumeFile(job.bid.id, 'docx');
  if (!docx) throw new BadRequestError('This application has no stored Resume to write the cover letter from.');
  const { value } = await mammoth.extractRawText({ buffer: docx.data });
  const resumeText = value.replace(/\n{3,}/g, '\n\n').trim();
  if (!resumeText) throw new BadRequestError('The stored Resume has no text to write the cover letter from.');
  return letterMessage(job, 'MY RESUME:', resumeText);
}

function letterMessage(job: MakeJob, resumeHeading: string, resumeText: string): string {
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
    resumeHeading,
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
  // Rendered once each and kept in the Resume folder; the JSON goes on the application.
  const context = {
    bidId: job.bid.id,
    ownerUserId: job.ownerUserId,
    bidDate: job.bid.bidDate,
    profileId: job.bid.candidate?.profileId,
  };
  const letterPdf = await coverLetterFile(context, letter, 'pdf');
  const letterDocx = await coverLetterFile(context, letter, 'docx');
  const bid = await bidsService.setBidCoverLetter(job.actor, job.bid.id, letter);
  await checkBidQuietly(job.bid.id);
  return {
    bid,
    files: {
      coverLetterPdf: { name: `${job.stem}_cover_letter.pdf`, base64: letterPdf.data.toString('base64') },
      coverLetterDocx: { name: `${job.stem}_cover_letter.docx`, base64: letterDocx.data.toString('base64') },
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
