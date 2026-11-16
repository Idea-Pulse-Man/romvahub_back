import { z } from 'zod';
import { RESUME_FORMATS, ResumePayloadSchema } from '../resume/resume.schemas.js';

/**
 * What the form sends to have a cover letter written.
 *
 * The Resume is part of the input rather than something the server looks up:
 * the letter is written from the document that is on screen, which on the
 * application form has not been saved yet and on the JSON route was never
 * generated here at all. It is the same document `POST /api/resume/generate`
 * answered with, handed straight back.
 */
export const GenerateCoverLetterSchema = z.object({
  company: z.string().trim().min(1, 'Company is required.').max(200),
  role: z.string().trim().min(1, 'Role is required.').max(200),
  jobDescription: z
    .string()
    .trim()
    .min(1, 'A job description is required.')
    .max(50_000, 'That job description is too long to write a cover letter from.'),
  resume: ResumePayloadSchema,
  /** Whose prompts write it — see `GenerateResumeSchema`. */
  userId: z.uuid('Not a valid account id.').optional(),
});

export type GenerateCoverLetterInput = z.infer<typeof GenerateCoverLetterSchema>;

/**
 * What the AI returns, and the exact shape the letter's template consumes.
 *
 * Four paragraphs rather than four named fields. The prompt's structure — Hook,
 * Core Value Proposition, Remote Proof, Call to Action — is a rule about *what
 * each paragraph says*, not about how the page is built: the template lays them
 * out identically whichever one is which, and a schema with four required
 * fields would fail a letter that came back with three good paragraphs instead
 * of laying out three good paragraphs.
 *
 * Nothing here is nullable and every field is required, for the same reason the
 * Resume's payload is: OpenAI's strict mode rejects a schema whose properties
 * are not all required, and the count rules live in the prompt where a near
 * miss costs a slightly wrong letter rather than a failed request.
 *
 * The paragraph text may carry `**bold**` — the prompt asks for a little of it
 * — which both renderers turn into bold runs. It is the only markup allowed.
 */
export const CoverLetterPayloadSchema = z.object({
  company: z.string().describe('The company applied to, echoed back.'),
  role: z.string().describe('The role applied for, echoed back.'),
  greeting: z.string().describe('The salutation, e.g. "Dear Hiring Manager,".'),
  paragraphs: z
    .array(z.string())
    .describe(
      'The body, one continuous paragraph per entry: the Hook, the Core Value ' +
        'Proposition, the Remote Proof and the Call to Action. `**bold**` is the only ' +
        'markup allowed inside them.',
    ),
  closing: z.string().describe('The sign-off above the name, e.g. "Sincerely,".'),
});

export type CoverLetterPayload = z.infer<typeof CoverLetterPayloadSchema>;

/**
 * Rendering is a separate request from generating, exactly as it is for the
 * Resume: the letter is written once and laid out as often as wanted, in either
 * format, without going back to the AI platform.
 */
export const RenderCoverLetterSchema = z.object({
  document: CoverLetterPayloadSchema,
  format: z.enum(RESUME_FORMATS),
  /**
   * Whose profile supplies the name, contact line and signature. Only an
   * administrator may name someone else — they pick the candidate on the
   * application form, and a letter signed by the wrong person is worse than one
   * that cannot be previewed. Everyone else gets their own profile whatever
   * they send.
   */
  userId: z.uuid('Not a valid account id.').optional(),
});

export type RenderCoverLetterInput = z.infer<typeof RenderCoverLetterSchema>;
