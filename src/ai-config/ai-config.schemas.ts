import { z } from 'zod';
import { AI_PROVIDERS } from '../resume/providers/index.js';

/**
 * What an admin may change about how Resumes and cover letters are written.
 *
 * Every field is optional, and every one accepts `null` to mean "stop
 * overriding this and go back to the environment". That is the difference
 * between a form that saves a blank and one that cannot express "unset" —
 * without it, clearing the model box would pin the model to `''`.
 */
export const AiSettingsSchema = z.object({
  provider: z.enum(AI_PROVIDERS).nullable().optional(),
  model: z.string().trim().max(200).nullable().optional(),
  systemPrompt: z.string().max(50_000).nullable().optional(),
  /**
   * The cover letter's prompt, edited and cleared independently of the
   * Resume's. Resetting one to its built-in default must not touch the other.
   */
  coverLetterPrompt: z.string().max(50_000).nullable().optional(),
  /**
   * Write-only. A new key replaces the stored one; `null` deletes it and hands
   * the provider back to its environment variable. Omit the field entirely to
   * leave whatever is stored alone — which is what every save that is not about
   * the key does, and why this cannot simply be a nullable string the form
   * always sends.
   */
  apiKey: z.string().trim().min(1).max(500).nullable().optional(),
});

export type AiSettingsInput = z.infer<typeof AiSettingsSchema>;
