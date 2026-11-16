import { BadGatewayError } from '../http/errors.js';
import { logger } from '../logger.js';
import { toMarkdown } from '../jobs/markdown.js';
import * as profileService from '../profile/profile.service.js';
import { generateStructured } from '../ai/generate.js';
import { resolveCoverLetterPrompt } from '../ai-config/ai-config.service.js';
import { resumeFileName } from '../resume/resume-file-name.js';
import { renderHtmlToPdf } from '../resume/template/pdf.js';
import { buildCoverLetterHtml } from './template/html.js';
import { buildCoverLetterDocx } from './template/docx.js';
import { buildCoverLetterSystemPrompt, buildCoverLetterUserPrompt } from './prompt.js';
import {
  CoverLetterPayloadSchema,
  type CoverLetterPayload,
  type GenerateCoverLetterInput,
  type RenderCoverLetterInput,
} from './cover-letter.schemas.js';
import type { AiProvider } from '../resume/providers/index.js';
import type { ResumeFormat } from '../resume/resume.schemas.js';

/**
 * The cover letter half of the application: written from the Resume that was
 * just generated, and laid out on the same page.
 *
 * Deliberately the Resume service's twin rather than a branch inside it. The
 * two share everything about *reaching* a platform — `generateStructured` holds
 * the config, the timeout and the three vendors' failure modes — and nothing
 * about what they write: a different prompt, a different schema, a different
 * template. The file name is the one thing they share: both are named after
 * the candidate and nothing else (see `resume-file-name.ts`).
 */

/** What the letter is called when the profile has no name to call it by. */
const NAMELESS_FILE = 'cover-letter';

export interface GeneratedCoverLetter {
  document: CoverLetterPayload;
  provider: AiProvider;
  model: string;
}

/**
 * Writes the cover letter for one application.
 *
 * A second call to the platform rather than a second field on the Resume's
 * answer. Asking for both at once would mean a letter that could not be
 * rewritten without also rewriting the Resume it was approved alongside — and
 * would put a page of letter inside a schema whose counts are already the hard
 * part to get right. It also means the letter is genuinely written *from* the
 * finished Resume, which is what the prompt asks for.
 */
export async function generateCoverLetter(
  input: GenerateCoverLetterInput,
  userId: string,
): Promise<GeneratedCoverLetter> {
  // The prompt in force for this account: its own, then the deployment's,
  // then the built-in default. Its own setting, not the Resume's — see
  // `src/cover-letter/prompt.ts`.
  const systemPrompt = await resolveCoverLetterPrompt(userId);

  // The description arrives as the sanitised HTML the editor stores. Markdown
  // is cheaper in tokens and easier for a model to read as structure — the same
  // conversion the Resume's own request does.
  const { markdown } = toMarkdown(input.jobDescription);

  const { value, provider, model } = await generateStructured({
    schema: CoverLetterPayloadSchema,
    name: 'cover_letter',
    label: 'cover letter',
    system: buildCoverLetterSystemPrompt(systemPrompt),
    user: buildCoverLetterUserPrompt({
      ...input,
      jobDescription: markdown || input.jobDescription,
    }),
  });

  return { document: value, provider, model };
}

export interface RenderedCoverLetter {
  file: Buffer;
  contentType: string;
  extension: ResumeFormat;
  /** `Andrew Zhu.docx` — the same name the Resume carries; see `resume-file-name.ts`. */
  fileName: string;
}

const CONTENT_TYPE: Record<ResumeFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * What to date the letter, when the document does not say.
 *
 * A caller holding the bid knows when the application was actually made, which
 * is the date the letter should carry rather than the date it happens to be
 * downloaded on.
 */
export interface CoverLetterNaming {
  /** `YYYY-MM-DD`. Today's date when the caller has nothing better. */
  date?: string;
  /**
   * The application Profile whose name, contact line and signature the letter
   * carries. Without it, the account's own profile — which, for an
   * application filed under a Profile, has no name ("Your Name").
   */
  profileId?: string;
}

/** Today, as the letter dates itself when nothing else says. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Renders a generated letter into the template, as PDF or as Word.
 *
 * The profile is read here, from the account the letter is for, and is never
 * part of the request: the name at the top and the signature at the bottom are
 * facts about the person, not something a client should be able to assert — and
 * not something the AI is shown either.
 */
export async function renderCoverLetter(
  userId: string,
  input: RenderCoverLetterInput,
  naming: CoverLetterNaming = {},
): Promise<RenderedCoverLetter> {
  // The application's Profile when it has one; else the account's own,
  // created at registration, so this never 404s for a real account.
  const profile = naming.profileId
    ? await profileService.getProfileById(naming.profileId)
    : await profileService.getProfile(userId);

  const fileName = (extension: string) =>
    resumeFileName({
      firstName: profile.firstName,
      lastName: profile.lastName,
      extension,
      fallback: NAMELESS_FILE,
    });

  const context = { date: naming.date || today() };

  if (input.format === 'docx') {
    return {
      file: await buildCoverLetterDocx(profile, input.document, context),
      contentType: CONTENT_TYPE.docx,
      extension: 'docx',
      fileName: fileName('docx'),
    };
  }

  const html = buildCoverLetterHtml(profile, input.document, context);

  let pdf: Buffer;
  try {
    pdf = await renderHtmlToPdf(html);
  } catch (error) {
    // Printing needs a browser, which is the one part of this that can be
    // missing from a deployment rather than merely failing.
    logger.error({ err: error }, 'Could not print the cover letter to PDF');
    throw new BadGatewayError(
      'The cover letter could not be printed to PDF. Downloading it as Word still works.',
    );
  }

  return { file: pdf, contentType: CONTENT_TYPE.pdf, extension: 'pdf', fileName: fileName('pdf') };
}
