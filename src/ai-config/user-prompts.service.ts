/**
 * One account's AI prompts, layered over the deployment's.
 *
 * The prompt is where a candidate's voice is set, and two candidates do not
 * share one — so each account may carry its own Resume and cover letter prompt,
 * while the provider, model and key stay deployment-wide. Each prompt falls
 * back independently: an account may have its own cover letter prompt and
 * leave the Resume's to the deployment.
 *
 * Admin-only, exactly as the deployment's are: the prompt is the product, and
 * a candidate no more edits their own than they edit the deployment's. This is
 * the second AI settings screen — the same two prompts, per profile — reached
 * through `/api/admin/users/:id/ai-prompts`; there is no self-service route.
 *
 * Editing goes through here; generation reads through `resolveSystemPrompt`
 * and `resolveCoverLetterPrompt` in `ai-config.service.ts`, which take the
 * account and consult its row first.
 */
import { prisma } from '../prisma.js';
import { NotFoundError } from '../http/errors.js';
import { getSettings } from './ai-config.service.js';
import type { UserAiPromptsInput } from './user-prompts.schemas.js';

export interface UserAiPromptsView {
  userId: string;
  /** The Resume prompt in force for this account. */
  systemPrompt: string;
  /** The cover letter prompt in force for this account. */
  coverLetterPrompt: string;
  /** Which of the two is set for this account rather than inherited from the deployment. */
  overrides: { systemPrompt: boolean; coverLetterPrompt: boolean };
  /** The deployment's prompts — what clearing an override reverts to. */
  defaults: { systemPrompt: string; coverLetterPrompt: string };
  updatedAt: string | null;
}

async function readRow(userId: string) {
  return prisma.userAiPrompts.findUnique({ where: { userId } });
}

export async function getUserPrompts(userId: string): Promise<UserAiPromptsView> {
  // A 404 rather than an empty view: an admin naming an account that does not
  // exist should hear so, not be shown the deployment's prompts as if it did.
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new NotFoundError('User not found.');

  const [row, deployment] = await Promise.all([readRow(userId), getSettings()]);

  return {
    userId,
    systemPrompt: row?.systemPrompt || deployment.systemPrompt,
    coverLetterPrompt: row?.coverLetterPrompt || deployment.coverLetterPrompt,
    overrides: {
      systemPrompt: Boolean(row?.systemPrompt),
      coverLetterPrompt: Boolean(row?.coverLetterPrompt),
    },
    defaults: {
      systemPrompt: deployment.systemPrompt,
      coverLetterPrompt: deployment.coverLetterPrompt,
    },
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/**
 * A partial update. An omitted field is left alone; an explicit `null` — or an
 * empty string, which is what a cleared textarea sends — drops that override
 * and hands the field back to the deployment.
 */
export async function updateUserPrompts(
  userId: string,
  input: UserAiPromptsInput,
): Promise<UserAiPromptsView> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new NotFoundError('User not found.');

  const data: { systemPrompt?: string | null; coverLetterPrompt?: string | null } = {};
  if ('systemPrompt' in input) data.systemPrompt = input.systemPrompt || null;
  if ('coverLetterPrompt' in input) data.coverLetterPrompt = input.coverLetterPrompt || null;

  await prisma.userAiPrompts.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });

  return getUserPrompts(userId);
}
