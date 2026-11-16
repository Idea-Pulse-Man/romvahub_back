import type { ZodType } from 'zod';
import { env } from '../../env.js';
import { ServiceUnavailableError } from '../../http/errors.js';

/**
 * One AI platform per adapter.
 *
 * The adapters exist so nothing above them knows which platform answered. An
 * admin screen will eventually choose the platform, supply its key and pick a
 * model from `listModels`; `resolveAiConfig` and `resolveApiKey` are the seams
 * it will read from — today they read the environment, and the shapes they
 * return are what an admin record will have to provide.
 */

export const AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'deepseek'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
  /**
   * How long the platform gets before the call is abandoned.
   *
   * Carried on the config rather than read from the environment inside each
   * adapter, so the three of them cannot drift — and so a caller with a
   * different budget (a background job, one day) can set its own.
   */
  timeoutMs: number;
}

/**
 * One request for a structured answer.
 *
 * The schema travels with the request rather than being fixed by the adapter,
 * because there is more than one thing the app asks a model to write: the
 * Resume, and the answers to an application's extra questions. Everything an
 * adapter does with a schema — hand it to a structured-output mode, or convert
 * it to JSON Schema — is the same whichever of the two it is.
 */
export interface StructuredRequest {
  system: string;
  user: string;
  /** The shape the platform is asked to answer in. */
  schema: ZodType;
  /** Names the output format. OpenAI requires a name; the others ignore it. */
  name: string;
  /**
   * What is being written, as it reads in a sentence shown to a user: "The AI
   * returned an empty Resume." Lowercase, no article.
   */
  label: string;
}

/** One turn in a conversation, as both the client and the platforms model it. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A conversation to continue.
 *
 * Separate from `StructuredRequest` because the two want opposite things. A
 * structured answer is one shot, is validated against a schema, and is worth
 * nothing until it is complete. A conversation is prose, has a history, and is
 * worth reading as it arrives — a person waiting twenty seconds for a
 * paragraph to appear all at once will assume it is broken.
 */
export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
}

/** One row in the model picker. */
export interface ModelOption {
  id: string;
  displayName: string;
}

/**
 * One AI platform.
 *
 * `generate` answers with the parsed JSON and nothing more — deliberately
 * `unknown` rather than a payload type. Two of the three SDKs validate against
 * the schema themselves and the third hands back a string, so checking it in
 * three places would mean three subtly different ideas of what "the wrong
 * shape" is. `src/ai/generate.ts` is the one place that decides.
 */
export interface AiPlatform {
  /** The platform's answer as parsed JSON, or a throw for the caller to translate. */
  generate(config: AiConfig, request: StructuredRequest): Promise<unknown>;
  /**
   * The reply to a conversation, in the pieces the platform produces it in.
   *
   * An async iterable of text fragments rather than a callback or a Node
   * stream: it is the one shape all three SDKs already speak, it composes with
   * `for await` at every layer above, and it carries a failure as a thrown
   * error rather than as an event nobody remembered to listen for.
   */
  chat(config: AiConfig, request: ChatRequest): AsyncIterable<string>;
  /** The models on this platform that can be generated with, newest first. */
  listModels(apiKey: string): Promise<ModelOption[]>;
}

/**
 * The model used when `AI_MODEL` says nothing, and the one a picker should
 * land on. Each is that platform's current general-purpose flagship; a
 * deployment that wants a cheaper or a newer one sets `AI_MODEL` rather than
 * waiting for this table to be edited.
 */
export const DEFAULT_MODEL: Record<AiProvider, string> = {
  openai: 'gpt-5',
  anthropic: 'claude-opus-5',
  gemini: 'gemini-2.5-pro',
  deepseek: 'deepseek-chat',
};

/** The environment variable each provider's key is read from, named for errors. */
export const KEY_VARIABLE: Record<AiProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

/**
 * The key to call `provider` with.
 *
 * A supplied key wins, which is the admin flow: the key being typed into the
 * form has not been saved anywhere yet, and listing that platform's models is
 * how you find out whether it works at all. With nothing supplied this falls
 * back to the environment, so the endpoint is usable before any admin screen
 * exists.
 *
 * A missing key is a 503 rather than a 500: the request was fine and the
 * deployment is simply not finished, which is worth saying plainly instead of
 * logging a stack trace nobody reads.
 */
export function resolveApiKey(provider: AiProvider, supplied?: string): string {
  const trimmed = supplied?.trim();
  if (trimmed) return trimmed;

  const configured = {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    gemini: env.GEMINI_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
  }[provider];

  if (!configured) {
    throw new ServiceUnavailableError(
      `No API key for ${provider}: ${KEY_VARIABLE[provider]} is not set, and none was supplied.`,
    );
  }

  return configured;
}

/** Which platform writes the Resume, with what credential and which model. */
export function resolveAiConfig(): AiConfig {
  const provider = env.AI_PROVIDER;

  return {
    provider,
    apiKey: resolveApiKey(provider),
    model: env.AI_MODEL || DEFAULT_MODEL[provider],
    timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
  };
}

/**
 * Loads the adapter for a platform.
 *
 * The import is dynamic so that a deployment running on OpenAI never loads the
 * Anthropic or Google SDK at all — three vendor SDKs is a lot of cold start to
 * pay for when only one of them can ever be called.
 */
export async function loadProvider(provider: AiProvider): Promise<AiPlatform> {
  switch (provider) {
    case 'openai':
      return (await import('./openai.js')).openAiProvider;
    case 'anthropic':
      return (await import('./anthropic.js')).anthropicProvider;
    case 'gemini':
      return (await import('./gemini.js')).geminiProvider;
    case 'deepseek':
      return (await import('./deepseek.js')).deepSeekProvider;
  }
}
