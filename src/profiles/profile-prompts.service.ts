import { readFile } from 'node:fs/promises';
import { isAdmin, type Actor } from '../auth/actor.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { prisma } from '../prisma.js';
import { isSharedWith } from '../admin/profiles.service.js';
import {
  listTemplates,
  readTemplateBytes,
  resolveTemplateId,
  saveUploadedTemplate,
  type TemplateInfo,
} from '../resume/maker/templates.js';

/**
 * Each application Profile's own Resume settings for "Make" in the
 * Applications table:
 *
 *   - Resume template (required) — the Word file the Resume is laid out in;
 *   - Resume prompt   (required for one step) — what the AI is told to write the Resume;
 *   - Step 1 and Step 2 prompts (required for two steps) — Step 1 asks for the
 *     information the Resume needs (company, role, experience) as JSON, Step 2
 *     writes the Resume from the job and Step 1's answer;
 *   - Cover letter prompt (optional) — empty means the short built-in prompt
 *     (or CHATGPT_COVER_LETTER_PROMPT_FILE).
 *
 * Every person writes differently and has their own layout, so nothing
 * required is borrowed from anyone else: Make refuses a Profile without its
 * own Resume prompt and template, rather than quietly writing a Resume in
 * someone else's voice.
 *
 * Edited by an admin *and* by every User the Profile is shared with. A
 * template uploaded here is stored under the Profile's name
 * (`Jonathan_Bai__resume.docx`), so one person's upload never replaces
 * another's template of the same file name.
 */

export const SIMPLE_COVER_LETTER_PROMPT = `Write a short, simple cover letter for the job below, based on the job description and my resume.

Rules:
- 3 or 4 short paragraphs, 180 to 260 words in total.
- Plain, natural, confident language. No cliches, no buzzword lists, no long dashes; use a normal dash "-".
- First paragraph: the role and the company, and why I am a good fit.
- Middle: connect 2 or 3 concrete achievements from my resume to the job's main requirements.
- Last paragraph: a brief, polite call to action.
- Use only facts from my resume. Do not invent experience, employers or numbers.
- Do not write a header, address, date or signature; those are added later.`;

/** Longest prompt accepted — P.txt is ~15 KB; this leaves plenty of room. */
export const MAX_PROMPT_LENGTH = 100_000;

/** The built-in generic template: a Profile still on it has no template of its own. */
const GENERIC_TEMPLATE = 'default.docx';

export async function defaultCoverLetterPrompt(): Promise<string> {
  const file = process.env.CHATGPT_COVER_LETTER_PROMPT_FILE?.trim();
  if (!file) return SIMPLE_COVER_LETTER_PROMPT;
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new BadRequestError(`CHATGPT_COVER_LETTER_PROMPT_FILE points at ${file}, which could not be read.`);
  }
}

/** How the Resume is made (the Start window's Method): one prompt, or Step 1 (information) → Step 2 (Resume). */
export type MakeMethod = 'one' | 'two';

export interface ProfileResumeSettings {
  /** Required for Make in one step. `null` until one is saved. */
  resumePrompt: string | null;
  /** Two steps: Step 1's prompt (the information the Resume needs, as JSON). Required for two steps. */
  resumeStep1Prompt: string | null;
  /** Two steps: Step 2's prompt (the Resume, from the job and Step 1's answer). Required for two steps. */
  resumeStep2Prompt: string | null;
  /** Optional. `null` means the simple built-in prompt (`defaults.coverLetterPrompt`). */
  coverLetterPrompt: string | null;
  /** The Word template the Resume is laid out in. */
  resumeTemplateId: string;
  /** Whether the template is the Profile's own, not the generic built-in one. */
  hasOwnTemplate: boolean;
  /** Every template there is, to pick from. */
  templates: TemplateInfo[];
  /** Whether Make can run in one step: an own Resume prompt and template. */
  ready: boolean;
  /** Whether Make can run in two steps: own Step 1 and Step 2 prompts and template. */
  twoStepReady: boolean;
  defaults: { coverLetterPrompt: string };
}

/** An admin reaches every Profile; a User only those shared with them. */
export async function assertProfileAccess(actor: Actor, profileId: string): Promise<void> {
  // A Profile token: its own Profile only.
  if (actor.profileId) {
    if (actor.profileId !== profileId) throw new NotFoundError('No such profile.');
    return;
  }
  const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { userId: true } });
  if (!profile) throw new NotFoundError('No such profile.');
  if (!isAdmin(actor) && profile.userId !== actor.id && !(await isSharedWith(actor.id, profileId))) {
    throw new NotFoundError('No such profile.');
  }
}

const isGeneric = (templateId: string) => templateId.toLowerCase() === GENERIC_TEMPLATE;

/** A Profile without what Make needs for the chosen method: a prompt, or its own template. */
export class PromptsMissingError extends BadRequestError {}

interface PromptRow {
  firstName: string;
  lastName: string;
  resumePrompt: string | null;
  resumeStep1Prompt: string | null;
  resumeStep2Prompt: string | null;
  resumeTemplateId: string;
}

const PROMPT_ROW = {
  firstName: true,
  lastName: true,
  resumePrompt: true,
  resumeStep1Prompt: true,
  resumeStep2Prompt: true,
  resumeTemplateId: true,
} as const;

/** What `row` lacks for Make with `method`, in words ("Jonathan Bai has no Step 2 prompt…"); null when nothing. */
function missingFor(row: PromptRow, method: MakeMethod): string | null {
  const who = `${row.firstName} ${row.lastName}`.trim() || 'This profile';
  const missing = [
    ...(method === 'two'
      ? [!row.resumeStep1Prompt?.trim() && 'Step 1 prompt', !row.resumeStep2Prompt?.trim() && 'Step 2 prompt']
      : [!row.resumePrompt?.trim() && 'Resume prompt']),
    isGeneric(row.resumeTemplateId) && 'Resume template',
  ].filter(Boolean);
  if (!missing.length) return null;
  return method === 'two'
    ? `${who} has no ${missing.join(' or ')} for two steps yet. Add them in Profiles → Prompts & Template (Two steps), or choose One step in the Start window.`
    : `${who} has no ${missing.join(' or ')} yet. Add it in Profiles → Prompts & Template, then click Make again.`;
}

/**
 * Refuses (PromptsMissingError, naming what is missing) when the Profile
 * cannot make a Resume with `method` — checked when the Resume maker is
 * started and when Make is clicked, so nothing is tried and failed for it.
 */
export async function assertReadyToMake(profileId: string, method: MakeMethod): Promise<void> {
  const row = await prisma.profile.findUnique({ where: { id: profileId }, select: PROMPT_ROW });
  if (!row) throw new NotFoundError('No such profile.');
  const problem = missingFor(row, method);
  if (problem) throw new PromptsMissingError(problem);
}

export async function getProfileSettings(actor: Actor, profileId: string): Promise<ProfileResumeSettings> {
  await assertProfileAccess(actor, profileId);
  const row = await prisma.profile.findUniqueOrThrow({
    where: { id: profileId },
    select: { ...PROMPT_ROW, coverLetterPrompt: true },
  });
  return {
    resumePrompt: row.resumePrompt,
    resumeStep1Prompt: row.resumeStep1Prompt,
    resumeStep2Prompt: row.resumeStep2Prompt,
    coverLetterPrompt: row.coverLetterPrompt,
    resumeTemplateId: row.resumeTemplateId,
    hasOwnTemplate: !isGeneric(row.resumeTemplateId),
    templates: await listTemplates(),
    ready: missingFor(row, 'one') === null,
    twoStepReady: missingFor(row, 'two') === null,
    defaults: { coverLetterPrompt: await defaultCoverLetterPrompt() },
  };
}

/**
 * Stores any of them. A field left out is untouched; for the prompts, `null`
 * or an empty string clears it (the cover letter then falls back to the
 * simple prompt; Make refuses without the Resume prompts of its method).
 */
export async function updateProfileSettings(
  actor: Actor,
  profileId: string,
  input: {
    resumePrompt?: string | null;
    resumeStep1Prompt?: string | null;
    resumeStep2Prompt?: string | null;
    coverLetterPrompt?: string | null;
    resumeTemplateId?: string;
  },
): Promise<ProfileResumeSettings> {
  await assertProfileAccess(actor, profileId);
  const clean = (value: string | null) => value?.trim() || null;
  await prisma.profile.update({
    where: { id: profileId },
    data: {
      ...(input.resumePrompt !== undefined ? { resumePrompt: clean(input.resumePrompt) } : {}),
      ...(input.resumeStep1Prompt !== undefined ? { resumeStep1Prompt: clean(input.resumeStep1Prompt) } : {}),
      ...(input.resumeStep2Prompt !== undefined ? { resumeStep2Prompt: clean(input.resumeStep2Prompt) } : {}),
      ...(input.coverLetterPrompt !== undefined ? { coverLetterPrompt: clean(input.coverLetterPrompt) } : {}),
      ...(input.resumeTemplateId !== undefined
        ? { resumeTemplateId: await resolveTemplateId(input.resumeTemplateId) }
        : {}),
    },
  });
  return getProfileSettings(actor, profileId);
}

/** "Jonathan", "Bai" → "Jonathan_Bai" — the prefix of the Profile's own template names. */
function templatePrefix(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'Profile';
}

/**
 * A new Resume template for one Profile: stored as `<Profile_Name>__<file>`
 * and made the Profile's template. Uploading the same file name again
 * replaces that Profile's copy only.
 */
export async function uploadProfileTemplate(
  actor: Actor,
  profileId: string,
  file: { originalName: string; bytes: Buffer },
): Promise<ProfileResumeSettings> {
  await assertProfileAccess(actor, profileId);
  const head = file.bytes.subarray(0, 4).toString('latin1');
  if (!file.originalName.toLowerCase().endsWith('.docx') || head !== 'PK\u0003\u0004') {
    throw new BadRequestError('The template must be a Word .docx file.');
  }
  const profile = await prisma.profile.findUniqueOrThrow({
    where: { id: profileId },
    select: { firstName: true, lastName: true },
  });
  const prefix = `${templatePrefix(profile.firstName, profile.lastName)}__`;
  const base = file.originalName.replace(/^.*[/\\]/, '');
  const name = base.startsWith(prefix) ? base : `${prefix}${base}`;
  const saved = await saveUploadedTemplate(name, file.bytes);
  await prisma.profile.update({ where: { id: profileId }, data: { resumeTemplateId: saved.id } });
  return getProfileSettings(actor, profileId);
}

/** The Profile's current template file, to download, edit in Word and upload again. */
export async function profileTemplateFile(
  actor: Actor,
  profileId: string,
): Promise<{ name: string; bytes: Buffer }> {
  await assertProfileAccess(actor, profileId);
  const { resumeTemplateId } = await prisma.profile.findUniqueOrThrow({
    where: { id: profileId },
    select: { resumeTemplateId: true },
  });
  const template = await readTemplateBytes(resumeTemplateId);
  return { name: template.id, bytes: template.bytes };
}

/** The prompts Make asks with, for one application. */
export interface MakePrompts {
  method: MakeMethod;
  /** The prompt that writes the Resume: one step's Resume prompt, or two steps' Step 2 prompt. */
  resumePrompt: string;
  /** Two steps: Step 1's prompt (the information the Resume needs). Null for one step. */
  step1Prompt: string | null;
  coverLetterPrompt: string;
  templateId: string;
}

/**
 * What "Make" uses for one application: its Profile's own Resume prompts for
 * `method` and its template (all required — a clear error names what is
 * missing), and its cover letter prompt or the simple one.
 */
export async function settingsForMake(input: {
  profileId?: string;
  ownerUserId: string;
  method?: MakeMethod;
}): Promise<MakePrompts> {
  const method = input.method ?? 'one';
  const row = await prisma.profile.findFirst({
    where: input.profileId ? { id: input.profileId } : { userId: input.ownerUserId },
    select: { ...PROMPT_ROW, coverLetterPrompt: true },
  });
  if (!row) throw new BadRequestError('This application has no profile to make a Resume for.');
  const problem = missingFor(row, method);
  if (problem) throw new PromptsMissingError(problem);
  return {
    method,
    resumePrompt: method === 'two' ? row.resumeStep2Prompt! : row.resumePrompt!,
    step1Prompt: method === 'two' ? row.resumeStep1Prompt! : null,
    coverLetterPrompt: row.coverLetterPrompt?.trim() || (await defaultCoverLetterPrompt()),
    templateId: row.resumeTemplateId,
  };
}
