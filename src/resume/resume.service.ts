import { BadGatewayError, BadRequestError } from '../http/errors.js';
import { logger } from '../logger.js';
import { toMarkdown } from '../jobs/markdown.js';
import * as profileService from '../profile/profile.service.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { generateStructured } from '../ai/generate.js';
import { resolveSystemPrompt, storedApiKeyFor } from '../ai-config/ai-config.service.js';
import { renderStructuredWithMaker } from './maker/maker.service.js';
import {
  DEFAULT_MODEL,
  loadProvider,
  resolveApiKey,
  type AiProvider,
  type ModelOption,
} from './providers/index.js';
import {
  AiResumeSchema,
  type GenerateResumeInput,
  type ListModelsInput,
  type RenderResumeInput,
  type ResumeFormat,
  type ResumePayload,
} from './resume.schemas.js';

export interface GeneratedResume {
  document: ResumePayload;
  provider: AiProvider;
  model: string;
}

/**
 * Writes the Resume's content for one application.
 *
 * Returns the payload rather than a file. Rendering is a second request, which
 * is what makes a Word copy of a Resume already on screen free: the AI is paid
 * for once, and both formats come from the one answer.
 */
export async function generateResume(
  input: GenerateResumeInput,
  userId: string,
): Promise<GeneratedResume> {
  // The prompt in force for this account: its own, then the deployment's,
  // then the built-in default. The provider, model, key and timeout are
  // resolved by `generateStructured`, which is where everything not specific
  // to a Resume now lives.
  const systemPrompt = await resolveSystemPrompt(userId);

  // The description arrives as the sanitised HTML the editor stores. Markdown is
  // both cheaper in tokens and easier for a model to read as structure, and the
  // converter for it is already here for the Parse route.
  const { markdown } = toMarkdown(input.jobDescription);

  const { value, provider, model } = await generateStructured({
    schema: AiResumeSchema,
    name: 'resume',
    label: 'Resume',
    system: buildSystemPrompt(systemPrompt),
    user: buildUserPrompt({ ...input, jobDescription: markdown || input.jobDescription }),
  });

  return { document: value, provider, model };
}

export interface RenderedResume {
  file: Buffer;
  contentType: string;
  extension: ResumeFormat;
  /** `Andrew Zhu.pdf` — see `resume-file-name.ts`. */
  fileName: string;
}

/**
 * Renders a generated payload the Resume Maker way: mail-merge into a Word
 * `.docx` template (styles live in the template). PDF uses Word COM when
 * available; otherwise an HTML approximation.
 */
export async function renderResume(userId: string, input: RenderResumeInput): Promise<RenderedResume> {
  // New applications use a first-class Profile; legacy rows still use the
  // account's 1:1 profile. The selected template belongs to that same identity.
  const profile = input.profileId
    ? await profileService.getProfileById(input.profileId)
    : await profileService.getProfile(userId);
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();

  const rendered = await renderStructuredWithMaker({
    document: input.document,
    format: input.format,
    name: name || undefined,
    // The template's <Company-N> slots: the document's own employers when it
    // carries them (pasted Resume Maker JSON), else the profile's work history.
    fallbackCompanies: profile.workExperience.map((entry) => entry.company),
    templateId: input.templateId || profile.resumeTemplateId,
  });

  return {
    file: rendered.file,
    contentType: rendered.contentType,
    extension: rendered.extension,
    fileName: rendered.fileName,
  };
}

export interface AvailableModels {
  provider: AiProvider;
  models: ModelOption[];
  /** What a picker should land on, when the list contains it. */
  defaultModel: string;
}

/**
 * The models a platform will let this key use.
 *
 * A rejected key is reported as a `400` rather than a `502`, because in the flow
 * this exists for the key is something a person just typed: "that key was
 * rejected" is about their input, and burying it in a bad-gateway error would
 * describe the wrong party as being at fault.
 */
export async function listModels(input: ListModelsInput): Promise<AvailableModels> {
  // A key typed into the form wins, then the one saved for this deployment,
  // then the environment's — so the picker can be opened without re-entering a
  // key that is already stored.
  const apiKey = resolveApiKey(
    input.provider,
    input.apiKey || (await storedApiKeyFor(input.provider)),
  );
  const provider = await loadProvider(input.provider);

  let models: ModelOption[];
  try {
    models = await provider.listModels(apiKey);
  } catch (error) {
    const status = statusOf(error);

    if (status === 401 || status === 403) {
      throw new BadRequestError(`That API key was rejected by ${input.provider}.`);
    }

    // Deliberately not logging the error object: an SDK's error can carry the
    // request that produced it, and that request carries the key.
    logger.error(
      { provider: input.provider, status },
      'Could not list models from the AI platform',
    );
    throw new BadGatewayError(
      `Could not reach ${input.provider} to list its models. Please try again.`,
    );
  }

  return { provider: input.provider, models, defaultModel: DEFAULT_MODEL[input.provider] };
}

/**
 * The HTTP status behind a vendor SDK's error, where there is one. Each of the
 * three throws its own error class and none of them share a base, so this reads
 * the field they happen to agree on rather than importing three types to test
 * against.
 */
function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
}
