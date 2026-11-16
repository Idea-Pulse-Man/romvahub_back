import { z } from 'zod';

/**
 * What an admin may change about one account's prompts — the same two the
 * deployment carries, with the same meaning for `null`: stop overriding this
 * one and fall back to the deployment's (or the built-in default behind it).
 *
 * No provider, model or key: those are infrastructure and stay deployment-wide.
 */
export const UserAiPromptsSchema = z.object({
  systemPrompt: z.string().max(50_000).nullable().optional(),
  coverLetterPrompt: z.string().max(50_000).nullable().optional(),
});

export type UserAiPromptsInput = z.infer<typeof UserAiPromptsSchema>;
