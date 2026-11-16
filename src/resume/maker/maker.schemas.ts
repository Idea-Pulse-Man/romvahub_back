import { z } from 'zod';
import { RESUME_FORMATS } from '../resume.schemas.js';

/**
 * Maker studio: flat (or nested) JSON + optional template id → DOCX or approx PDF.
 *
 * `json` may be a string (textarea paste) or an already-parsed object.
 */
export const ProcessMakerSchema = z.object({
  json: z.union([
    z.string().trim().min(2, 'Paste Resume Maker JSON.').max(500_000),
    z.record(z.string(), z.unknown()),
  ]),
  format: z.enum(RESUME_FORMATS),
  templateId: z
    .string()
    .trim()
    .max(130)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.docx$/i, 'Not a valid template id.')
    .optional(),
});

export type ProcessMakerInput = z.infer<typeof ProcessMakerSchema>;
