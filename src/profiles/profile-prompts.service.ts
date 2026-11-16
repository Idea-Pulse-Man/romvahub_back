import { readFile } from 'node:fs/promises';
import { isAdmin, type Actor } from '../auth/actor.js';
import { resolveSystemPrompt } from '../ai-config/ai-config.service.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { prisma } from '../prisma.js';
import { isSharedWith } from '../admin/profiles.service.js';

/**
 * Each application Profile's own ChatGPT prompts for "Make" in the
 * Applications table: one for the Resume, one for the cover letter.
 *
 * Unlike the account prompts on Profile AI Settings (admin only), these are
 * edited by an admin *and* by every User the Profile is shared with — the
 * person making the Resumes is the one tuning how they read.
 *
 * Empty means "the default", which is, in order:
 *   Resume:       CHATGPT_PROMPT_FILE, then AI Settings (account, deployment), then built-in
 *   Cover letter: CHATGPT_COVER_LETTER_PROMPT_FILE, then the short built-in prompt below
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

async function promptFile(variable: string): Promise<string | null> {
  const file = process.env[variable]?.trim();
  if (!file) return null;
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new BadRequestError(`${variable} points at ${file}, which could not be read.`);
  }
}

export async function defaultResumePrompt(ownerUserId?: string): Promise<string> {
  return (await promptFile('CHATGPT_PROMPT_FILE')) ?? (await resolveSystemPrompt(ownerUserId));
}

export async function defaultCoverLetterPrompt(): Promise<string> {
  return (await promptFile('CHATGPT_COVER_LETTER_PROMPT_FILE')) ?? SIMPLE_COVER_LETTER_PROMPT;
}

export interface ProfilePrompts {
  /** This Profile's own prompt, or `null` when it uses the default. */
  resumePrompt: string | null;
  coverLetterPrompt: string | null;
  /** What is used while the Profile has none — shown in the editor. */
  defaults: { resumePrompt: string; coverLetterPrompt: string };
}

/** An admin reaches every Profile; a User only those shared with them. */
async function assertProfileAccess(actor: Actor, profileId: string): Promise<{ userId: string | null }> {
  const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { userId: true } });
  if (!profile) throw new NotFoundError('No such profile.');
  if (!isAdmin(actor) && profile.userId !== actor.id && !(await isSharedWith(actor.id, profileId))) {
    throw new NotFoundError('No such profile.');
  }
  return profile;
}

export async function getProfilePrompts(actor: Actor, profileId: string): Promise<ProfilePrompts> {
  const { userId } = await assertProfileAccess(actor, profileId);
  const row = await prisma.profile.findUniqueOrThrow({
    where: { id: profileId },
    select: { resumePrompt: true, coverLetterPrompt: true },
  });
  return {
    resumePrompt: row.resumePrompt,
    coverLetterPrompt: row.coverLetterPrompt,
    defaults: {
      resumePrompt: await defaultResumePrompt(userId ?? undefined),
      coverLetterPrompt: await defaultCoverLetterPrompt(),
    },
  };
}

/**
 * Stores either prompt or both. A field left out is untouched; `null` or an
 * empty string clears it back to the default.
 */
export async function updateProfilePrompts(
  actor: Actor,
  profileId: string,
  input: { resumePrompt?: string | null; coverLetterPrompt?: string | null },
): Promise<ProfilePrompts> {
  await assertProfileAccess(actor, profileId);
  const clean = (value: string | null | undefined) => (value === undefined ? undefined : value?.trim() || null);
  await prisma.profile.update({
    where: { id: profileId },
    data: {
      ...(input.resumePrompt !== undefined ? { resumePrompt: clean(input.resumePrompt) } : {}),
      ...(input.coverLetterPrompt !== undefined ? { coverLetterPrompt: clean(input.coverLetterPrompt) } : {}),
    },
  });
  return getProfilePrompts(actor, profileId);
}

/**
 * The prompts "Make" uses for one application: its Profile's own, else the
 * defaults. A legacy application without a Profile uses its owner's account
 * profile row, when there is one.
 */
export async function promptsForMake(input: {
  profileId?: string;
  ownerUserId: string;
}): Promise<{ resumePrompt: string; coverLetterPrompt: string }> {
  const row = await prisma.profile.findFirst({
    where: input.profileId ? { id: input.profileId } : { userId: input.ownerUserId },
    select: { resumePrompt: true, coverLetterPrompt: true },
  });
  return {
    resumePrompt: row?.resumePrompt || (await defaultResumePrompt(input.ownerUserId)),
    coverLetterPrompt: row?.coverLetterPrompt || (await defaultCoverLetterPrompt()),
  };
}
