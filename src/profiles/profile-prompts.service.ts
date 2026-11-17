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
 *   - Resume prompt   (required) — what ChatGPT is told to write the Resume;
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

export interface ProfileResumeSettings {
  /** Required for Make. `null` until one is saved. */
  resumePrompt: string | null;
  /** Optional. `null` means the simple built-in prompt (`defaults.coverLetterPrompt`). */
  coverLetterPrompt: string | null;
  /** The Word template the Resume is laid out in. */
  resumeTemplateId: string;
  /** Whether the template is the Profile's own, not the generic built-in one. */
  hasOwnTemplate: boolean;
  /** Every template there is, to pick from. */
  templates: TemplateInfo[];
  /** Whether Make can run: an own Resume prompt and template. */
  ready: boolean;
  defaults: { coverLetterPrompt: string };
}

/** An admin reaches every Profile; a User only those shared with them. */
export async function assertProfileAccess(actor: Actor, profileId: string): Promise<void> {
  const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { userId: true } });
  if (!profile) throw new NotFoundError('No such profile.');
  if (!isAdmin(actor) && profile.userId !== actor.id && !(await isSharedWith(actor.id, profileId))) {
    throw new NotFoundError('No such profile.');
  }
}

const isGeneric = (templateId: string) => templateId.toLowerCase() === GENERIC_TEMPLATE;

export async function getProfileSettings(actor: Actor, profileId: string): Promise<ProfileResumeSettings> {
  await assertProfileAccess(actor, profileId);
  const row = await prisma.profile.findUniqueOrThrow({
    where: { id: profileId },
    select: { resumePrompt: true, coverLetterPrompt: true, resumeTemplateId: true },
  });
  return {
    resumePrompt: row.resumePrompt,
    coverLetterPrompt: row.coverLetterPrompt,
    resumeTemplateId: row.resumeTemplateId,
    hasOwnTemplate: !isGeneric(row.resumeTemplateId),
    templates: await listTemplates(),
    ready: Boolean(row.resumePrompt?.trim()) && !isGeneric(row.resumeTemplateId),
    defaults: { coverLetterPrompt: await defaultCoverLetterPrompt() },
  };
}

/**
 * Stores any of the three. A field left out is untouched; for the prompts,
 * `null` or an empty string clears it (the cover letter then falls back to
 * the simple prompt; Make refuses without a Resume prompt).
 */
export async function updateProfileSettings(
  actor: Actor,
  profileId: string,
  input: { resumePrompt?: string | null; coverLetterPrompt?: string | null; resumeTemplateId?: string },
): Promise<ProfileResumeSettings> {
  await assertProfileAccess(actor, profileId);
  const clean = (value: string | null) => value?.trim() || null;
  await prisma.profile.update({
    where: { id: profileId },
    data: {
      ...(input.resumePrompt !== undefined ? { resumePrompt: clean(input.resumePrompt) } : {}),
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

/**
 * What "Make" uses for one application: its Profile's own Resume prompt and
 * template (both required — a clear error names what is missing), and its
 * cover letter prompt or the simple one.
 */
export async function settingsForMake(input: {
  profileId?: string;
  ownerUserId: string;
}): Promise<{ resumePrompt: string; coverLetterPrompt: string; templateId: string }> {
  const row = await prisma.profile.findFirst({
    where: input.profileId ? { id: input.profileId } : { userId: input.ownerUserId },
    select: { firstName: true, lastName: true, resumePrompt: true, coverLetterPrompt: true, resumeTemplateId: true },
  });
  if (!row) throw new BadRequestError('This application has no profile to make a Resume for.');
  const who = `${row.firstName} ${row.lastName}`.trim() || 'This profile';
  const missing = [
    !row.resumePrompt?.trim() && 'a Resume prompt',
    isGeneric(row.resumeTemplateId) && 'a Resume template',
  ].filter(Boolean);
  if (missing.length) {
    throw new BadRequestError(
      `${who} has no ${missing.join(' and ')} yet. Add it in Profiles → Prompts & Template, then click Make again.`,
    );
  }
  return {
    resumePrompt: row.resumePrompt!,
    coverLetterPrompt: row.coverLetterPrompt?.trim() || (await defaultCoverLetterPrompt()),
    templateId: row.resumeTemplateId,
  };
}
