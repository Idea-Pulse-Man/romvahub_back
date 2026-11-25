import type { Actor } from '../auth/actor.js';
import * as bidsService from '../bids/bids.service.js';
import type { Bid } from '../domain/types.js';
import { BadGatewayError, BadRequestError } from '../http/errors.js';
import { toMarkdown } from '../jobs/markdown.js';
import * as profileService from '../profile/profile.service.js';
import { convertDocxToPdf, processMakerJson, renderStructuredWithMaker } from '../resume/maker/maker.service.js';
import { ResumePayloadSchema } from '../resume/resume.schemas.js';
import { CoverLetterPayloadSchema, type CoverLetterPayload } from '../cover-letter/cover-letter.schemas.js';
import { renderCoverLetter } from '../cover-letter/cover-letter.service.js';
import { settingsForMake } from '../profiles/profile-prompts.service.js';
import mammoth from 'mammoth';
import { parseJsonAnswer } from './json-answer.js';
import { resumeAnswerProblems, resumeRetryMessage, templateLayout, type TemplateLayout } from './resume-answer-check.js';
import { checkBidQuietly } from '../resume/resume-check.js';

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
  /**
   * For a Resume prompt with `{{CANDIDATE}}`: the Profile's own jobs the
   * Resume is written from, one per job in the template. The AI writes the
   * summary, skills and bullet points; the job titles, employers and places
   * are these, never the AI's.
   */
  history?: HistoryJob[];
}

export interface HistoryJob {
  title: string;
  company: string;
  location: string;
  /** `01/2024 - Present` */
  dates: string;
}

/** In a Profile's Resume prompt: where the Profile's own work history goes. */
const CANDIDATE_MARK = /\{\{\s*CANDIDATE\s*\}\}/i;
/** Asked for when the template has no numbered slots to count. */
const DEFAULT_BULLETS = 4;
const DEFAULT_SKILL_GROUPS = 6;
const REPLY_JSON = 'Reply with the JSON only, in a single ```json code block.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** `2024-01` → `01/2024`; null (still there) → `Present`. */
function monthYear(value: string | null): string {
  if (value === null) return 'Present';
  const match = /^(\d{4})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[1]}` : value.trim();
}

/** `2024-01` → months since year 0, or null. */
function monthIndex(value: string): number | null {
  const match = /^(\d{4})-(\d{2})/.exec(value);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

/** Whole years from the first job's start to the last one's end (today for a current job). */
function yearsOfExperience(jobs: MakeJob['profile']['workExperience'], now = new Date()): number {
  const today = now.getFullYear() * 12 + now.getMonth();
  const known = (month: number | null): month is number => month !== null;
  const starts = jobs.map((job) => monthIndex(job.startDate)).filter(known);
  const ends = jobs.map((job) => (job.endDate ? monthIndex(job.endDate) : today)).filter(known);
  if (!starts.length || !ends.length) return 0;
  return Math.floor((Math.max(...ends) - Math.min(...starts)) / 12);
}

/** The Profile's jobs for the template's job slots, in the Profile's order — each with its company and title. */
function historyFor(profile: MakeJob['profile'], layout: TemplateLayout, who: string): HistoryJob[] {
  const jobs = profile.workExperience.filter((job) => job.company.trim() || job.title.trim());
  if (!jobs.length) {
    throw new BadRequestError(
      `${who} has no work experience in the Profile, which the Resume prompt's {{CANDIDATE}} needs. ` +
        'Add the jobs (company, title, dates) in Profiles → Edit, then click Make again.',
    );
  }
  const used = layout.bullets.length ? jobs.slice(0, layout.bullets.length) : jobs;
  used.forEach((job, index) => {
    const missing = !job.company.trim() ? 'company' : !job.title.trim() ? 'job title' : '';
    if (missing) {
      throw new BadRequestError(`${who}'s work experience ${index + 1} has no ${missing}. Add it in Profiles → Edit, then click Make again.`);
    }
  });
  return used.map((job) => ({
    title: job.title.trim(),
    company: job.company.trim(),
    location: job.location.trim(),
    dates: [monthYear(job.startDate), monthYear(job.endDate)].filter(Boolean).join(' - '),
  }));
}

/** What `{{CANDIDATE}}` stands for: the jobs, years of experience and education, as the Profile has them. */
function candidateText(history: HistoryJob[], profile: MakeJob['profile']): string {
  const years = yearsOfExperience(profile.workExperience);
  const education = profile.education
    .slice(0, 2)
    .map((entry) => [entry.degree, entry.major, entry.university, entry.endDate?.slice(0, 4)].filter(Boolean).join(', '))
    .filter(Boolean)
    .join('; ');
  return [
    'MY WORK HISTORY (use exactly as written; add no other jobs, titles, degrees or certifications):',
    ...history.map((job, index) => `${index + 1}. ${[job.title, job.company, job.location, job.dates].filter(Boolean).join(' | ')}`),
    ...(years > 0 ? [`Experience: ${years} years`] : []),
    ...(education ? [`Education: ${education}`] : []),
  ].join('\n');
}

/** "7, 6 and 5" */
function spokenList(values: number[]): string {
  return values.length > 1 ? `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}` : String(values[0] ?? '');
}

/** The answer's shape, sized to the template: what `withHistory` reads back. */
function outputText(history: HistoryJob[], layout: TemplateLayout): string {
  const shape = {
    ...(layout.headline ? { headline: '<role applied for> | <1-2 core strengths>' } : {}),
    summary: '<summary>',
    skills: ['<Group>: <skill>, <skill>, <skill>, <skill>'],
    bullets: history.map((_, index) => [`<job ${index + 1} bullet>`]),
  };
  const bullets = history.map((_, index) => layout.bullets[index] || DEFAULT_BULLETS);
  return [
    'OUTPUT: one JSON object with exactly these keys:',
    JSON.stringify(shape),
    `- skills: ${layout.skillGroups || DEFAULT_SKILL_GROUPS} groups`,
    `- bullets: one list per job, in the order above: ${spokenList(bullets)} bullets`,
  ].join('\n');
}

/** Whether a Resume prompt is written around the Profile's own work history (`{{CANDIDATE}}`). */
export function usesProfileHistory(prompt: string): boolean {
  return CANDIDATE_MARK.test(prompt);
}

/**
 * The first chat for a `{{CANDIDATE}}` prompt: the prompt with the Profile's
 * history in it, the posting as plain text, then the answer's shape sized to
 * the template. Throws (400) when the Profile has no work history to use.
 */
export function historyRequest(input: {
  prompt: string;
  profile: MakeJob['profile'];
  bid: Pick<Bid, 'company' | 'role'>;
  jobDescription: string;
  layout: TemplateLayout;
  /** The Profile's name, for the error messages. */
  who: string;
}): { history: HistoryJob[]; message: string } {
  const history = historyFor(input.profile, input.layout, input.who);
  const candidate = candidateText(history, input.profile);
  const message = [
    input.prompt.replace(new RegExp(CANDIDATE_MARK.source, 'gi'), () => candidate).trim(),
    '',
    'JOB',
    `Company: ${input.bid.company}`,
    `Role: ${input.bid.role}`,
    input.jobDescription,
    '',
    outputText(history, input.layout),
    '',
    REPLY_JSON,
  ].join('\n');
  return { history, message };
}

/**
 * An answer to a `{{CANDIDATE}}` request as the template is filled from it:
 * the AI's summary, skills and bullet points, with the Profile's own job
 * titles, employers and places, whatever the answer says about them.
 */
export function withHistory(job: Pick<MakeJob, 'history' | 'bid'>, json: unknown): unknown {
  if (!job.history || !isRecord(json)) return json;
  const skills = isRecord(json.skills)
    ? // {"Group": "a, b"} for ["Group: a, b"]: the same thing.
      Object.entries(json.skills).map(([group, value]) => `${group}: ${Array.isArray(value) ? value.join(', ') : String(value ?? '')}`)
    : json.skills;
  return {
    ...json,
    skills,
    headline: typeof json.headline === 'string' ? json.headline : undefined,
    company: job.bid.company,
    role: job.bid.role,
    roleTitles: job.history.map((entry) => entry.title),
    companies: job.history.map((entry) => entry.company),
    locations: job.history.map((entry) => entry.location),
  };
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

  let history: HistoryJob[] | undefined;
  let resumeMessage: string;
  if (usesProfileHistory(prompts.resumePrompt)) {
    ({ history, message: resumeMessage } = historyRequest({
      prompt: prompts.resumePrompt,
      profile,
      bid,
      jobDescription,
      layout: await templateLayout(prompts.templateId),
      who: [firstName, lastName].filter(Boolean).join(' ') || 'This Profile',
    }));
  } else {
    const input = JSON.stringify(
      { target_company: bid.company, target_role: bid.role, job_description: jobDescription },
      null,
      2,
    );
    resumeMessage = [
      prompts.resumePrompt,
      '',
      '================================================================================',
      'INPUT',
      '================================================================================',
      input,
      '',
      REPLY_JSON,
    ].join('\n');
  }

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
    ...(history ? { history } : {}),
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

/** What is missing from a parsed Resume answer for this Profile's template (empty: it can be built). */
function problemsIn(job: MakeJob, json: object): Promise<string[]> {
  return resumeAnswerProblems(json, {
    templateId: job.prompts.templateId,
    name: profileName(job) || undefined,
    fallbackCompanies: job.profile.workExperience.map((entry) => entry.company),
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
  const problems = await problemsIn(job, withHistory(job, json) as object);
  return problems.length ? { problems, retryMessage: resumeRetryMessage(job.resumeMessage, problems, json) } : { problems };
}

/** ChatGPT's first answer → the Resume in the Profile's Word template, as Word and PDF, stored on the application. */
export async function finishResume(job: MakeJob, answer: string): Promise<FinishedResume> {
  const json = withHistory(job, parseJsonAnswer(answer));

  // A Resume with an empty summary, no skills or a job without a title is
  // never stored: refused like an unreadable answer (and tried again later).
  const problems = await problemsIn(job, json as object);
  if (problems.length) {
    throw new BadGatewayError(`ChatGPT's Resume JSON is incomplete: ${problems.join('; ')}.`);
  }

  // The app's own prompt answers in its structured shape; a Resume Maker
  // prompt (P.txt) in Maker JSON. Both go into the same Word template.
  const templateId = job.prompts.templateId;
  const name = profileName(job);
  const structured = ResumePayloadSchema.safeParse(json);
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
  if (job.history) return letterMessage(job, 'MY RESUME:', historyResumeText(job.history, resume));
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
  const docx = await bidsService.getResumeFile(job.actor, job.bid.id, 'docx');
  if (!docx) throw new BadRequestError('This application has no stored Resume to write the cover letter from.');
  const { value } = await mammoth.extractRawText({ buffer: docx.data });
  const resumeText = value.replace(/\n{3,}/g, '\n\n').trim();
  if (!resumeText) throw new BadRequestError('The stored Resume has no text to write the cover letter from.');
  return letterMessage(job, 'MY RESUME:', resumeText);
}

/** A Resume written from the Profile's history, as plain text: what the letter is written from, in fewer words than its JSON. */
function historyResumeText(history: HistoryJob[], resume: unknown): string {
  const document = isRecord(resume) ? resume : {};
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const lines = (value: unknown) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
  const bullets = Array.isArray(document.bullets) ? document.bullets : [];
  return [
    text(document.headline),
    text(document.summary),
    lines(document.skills).join('\n'),
    ...history.map((job, index) =>
      [[job.title, job.company, job.dates].filter(Boolean).join(', '), ...lines(bullets[index]).map((bullet) => `- ${bullet}`)].join('\n'),
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
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
  await checkBidQuietly(job.bid.id);
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
