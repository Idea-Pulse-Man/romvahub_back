import { z } from 'zod';
import { AI_PROVIDERS } from './providers/index.js';

/**
 * What the form sends. The three fields the Resume is written from — nothing
 * else about the user reaches the model from here; anything the Resume says
 * about the candidate comes from the system prompt.
 */
export const GenerateResumeSchema = z.object({
  company: z.string().trim().min(1, 'Company is required.').max(200),
  role: z.string().trim().min(1, 'Role is required.').max(200),
  jobDescription: z
    .string()
    .trim()
    .min(1, 'A job description is required.')
    // The bid column accepts 50k characters of HTML; a posting longer than this
    // once the tags come off is not a posting.
    .max(50_000, 'That job description is too long to generate a Resume from.'),
  /**
   * Whose prompts write it. An account may carry its own Resume and cover
   * letter prompt (`/api/admin/users/:id/ai-prompts`), and an administrator
   * generating for a candidate wants that candidate's voice, not their own.
   * Only an admin may name someone else; everyone else gets their own whatever
   * they send.
   */
  userId: z.uuid('Not a valid account id.').optional(),
});

export type GenerateResumeInput = z.infer<typeof GenerateResumeSchema>;

/**
 * What the admin screen asks for once a platform has been chosen and a key
 * typed in: the models that key can actually reach.
 *
 * `apiKey` is optional so the endpoint is usable before that screen exists —
 * omitted, it falls back to the key in the environment. When it is supplied it
 * is used and discarded: nothing stores it, and nothing logs it.
 */
export const ListModelsSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  apiKey: z.string().trim().min(1).max(500).optional(),
});

export type ListModelsInput = z.infer<typeof ListModelsSchema>;

/**
 * What the AI returns, and the exact shape the Resume template consumes.
 *
 * This mirrors the payload the resume-builder desktop app is driven by, so a
 * document generated here and one built by hand there are the same document.
 * The system prompt asks for these fields by name; the schema is also handed to
 * the platform's structured-output mode, so the shape is enforced rather than
 * hoped for.
 *
 * The *counts* are not enforced here — 6 skill lines, bullet groups of 5/4/3/2 —
 * because OpenAI's strict mode does not implement `minItems`/`maxItems`, and a
 * schema only one of the three platforms accepts defeats the point of having
 * three. Those rules live in the prompt, which is where a near miss should cost
 * a slightly wrong Resume rather than a failed request.
 */
/**
 * What the AI is asked to write. Kept apart from `ResumePayloadSchema` so the
 * structured-output contract the providers see does not change when the stored
 * document gains a field the AI never fills.
 */
export const AiResumeSchema = z.object({
  company: z.string().describe('The company applied to, echoed back.'),
  role: z.string().describe('The role applied for, echoed back.'),
  roleTitles: z
    .array(z.string())
    .describe('One title per employer, newest first, aligned with `bullets`.'),
  summary: z.string().describe('One continuous paragraph. No newlines, no bullets.'),
  skills: z
    .array(z.string())
    .describe('One line per category, e.g. "Languages: Go | Python | Java | TypeScript".'),
  bullets: z
    .array(z.array(z.string()))
    .describe('One group per employer, newest first, aligned with `roleTitles`.'),
});

/**
 * A Resume as stored on an application and rendered: the AI's document, plus
 * what pasted Resume Maker JSON can carry beyond it.
 */
export const ResumePayloadSchema = AiResumeSchema.extend({
  companies: z
    .array(z.string())
    .optional()
    .describe(
      'Employer per role, newest first, aligned with `roleTitles` (Resume Maker `Company-N`). ' +
        "When absent, the profile's work history fills the template's company slots.",
    ),
  locations: z
    .array(z.string())
    .optional()
    .describe('Place per role, newest first, aligned with `roleTitles` (the template\'s `Location-N`).'),
  headline: z
    .string()
    .optional()
    .describe("The line under the name (`Professional-Title`, `resume-title`); the role applied for when absent."),
});

export type ResumePayload = z.infer<typeof ResumePayloadSchema>;

export const RESUME_FORMATS = ['pdf', 'docx'] as const;
export type ResumeFormat = (typeof RESUME_FORMATS)[number];

/**
 * Rendering is a separate request from generating so that a second file costs
 * nothing at the AI platform: the payload is generated once and rendered as
 * often as the user wants, in either format.
 */
export const RenderResumeSchema = z.object({
  document: ResumePayloadSchema,
  format: z.enum(RESUME_FORMATS),
  templateId: z
    .string()
    .trim()
    .max(130)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.docx$/i, 'Not a valid Resume template.')
    .optional(),
  /** First-class application Profile supplying Resume facts and its default template. */
  profileId: z.uuid('Not a valid profile id.').optional(),
  /**
   * Whose profile supplies the name, contact line, employers and degrees.
   *
   * Only an administrator may name someone else — they pick the candidate on
   * the application form, and a preview rendered from their own profile would
   * carry the wrong name. Everyone else gets their own profile whatever they
   * send.
   */
  userId: z.uuid('Not a valid account id.').optional(),
});

export type RenderResumeInput = z.infer<typeof RenderResumeSchema>;
