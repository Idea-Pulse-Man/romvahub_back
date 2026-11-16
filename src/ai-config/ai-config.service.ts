/**
 * The deployment's AI settings, as an admin edits them.
 *
 * The environment is the fallback, not the alternative: every field falls back
 * independently, so an admin can override the model and leave the provider and
 * key exactly as the deployment configured them. A fresh install with no row
 * behaves precisely as it did before this feature existed.
 *
 * The API key is the one value that goes in and never comes out. `getSettings`
 * reports where the key comes from and nothing else; `resolveAiConfig` below is
 * the only reader that decrypts one, and it hands it straight to a provider.
 */
import { prisma } from '../prisma.js';
import { decryptSecret, encryptSecret } from '../crypto/secret-box.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { DEFAULT_SYSTEM_PROMPT } from '../resume/prompt.js';
import { DEFAULT_COVER_LETTER_PROMPT } from '../cover-letter/prompt.js';
import {
  DEFAULT_MODEL,
  KEY_VARIABLE,
  type AiConfig,
  type AiProvider,
} from '../resume/providers/index.js';
import { ServiceUnavailableError } from '../http/errors.js';
import type { AiSettingsInput } from './ai-config.schemas.js';

/** Where the key in force comes from, which is all the UI needs to know. */
export type KeySource = 'database' | 'environment' | 'none';

export interface AiSettingsView {
  provider: AiProvider;
  model: string;
  systemPrompt: string;
  /**
   * The prompt the cover letter is written from. Its own field rather than a
   * section of the Resume's: the two documents are held to different rules, and
   * one prompt serving both would be edited for one and quietly change the
   * other.
   */
  coverLetterPrompt: string;
  /** True when this deployment has a usable key from either source. */
  hasApiKey: boolean;
  keySource: KeySource;
  /** Which of the editable fields are overridden here rather than by the env. */
  overrides: {
    provider: boolean;
    model: boolean;
    systemPrompt: boolean;
    coverLetterPrompt: boolean;
  };
  /** The environment's values, so the form can show what "clear" reverts to. */
  defaults: { provider: AiProvider; model: string; keyVariable: string };
  updatedAt: string | null;
}

const SINGLETON = { id: 1 } as const;

function envKeyFor(provider: AiProvider): string | undefined {
  return {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    gemini: env.GEMINI_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
  }[provider];
}

async function readRow() {
  return prisma.aiSettings.findUnique({ where: SINGLETON });
}

export async function getSettings(): Promise<AiSettingsView> {
  const row = await readRow();

  const provider = (row?.provider as AiProvider | null) ?? env.AI_PROVIDER;
  const storedKey = decryptSecret(row?.apiKeyEncrypted);

  // A stored key that will not decrypt is reported as absent rather than as
  // present-but-broken: the fix is to save a new one, and saying "a key is set"
  // about a value nothing can read would send an admin looking elsewhere.
  if (row?.apiKeyEncrypted && storedKey === null) {
    logger.warn(
      'The stored AI API key could not be decrypted — CONFIG_ENCRYPTION_KEY or ' +
        'JWT_ACCESS_SECRET has changed since it was saved. Falling back to the environment.',
    );
  }

  const envKey = envKeyFor(provider);
  const keySource: KeySource = storedKey ? 'database' : envKey ? 'environment' : 'none';

  return {
    provider,
    model: row?.model || env.AI_MODEL || DEFAULT_MODEL[provider],
    systemPrompt: row?.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    coverLetterPrompt: row?.coverLetterPrompt || DEFAULT_COVER_LETTER_PROMPT,
    hasApiKey: keySource !== 'none',
    keySource,
    overrides: {
      provider: row?.provider != null,
      model: Boolean(row?.model),
      systemPrompt: Boolean(row?.systemPrompt),
      coverLetterPrompt: Boolean(row?.coverLetterPrompt),
    },
    defaults: {
      provider: env.AI_PROVIDER,
      model: env.AI_MODEL || DEFAULT_MODEL[env.AI_PROVIDER],
      keyVariable: KEY_VARIABLE[provider],
    },
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/**
 * A partial update. An omitted field is left alone; an explicit `null` clears
 * the override and hands that field back to the environment.
 */
export async function updateSettings(input: AiSettingsInput): Promise<AiSettingsView> {
  const data: {
    provider?: string | null;
    model?: string | null;
    systemPrompt?: string | null;
    coverLetterPrompt?: string | null;
    apiKeyEncrypted?: string | null;
  } = {};

  if ('provider' in input) data.provider = input.provider ?? null;
  if ('model' in input) data.model = input.model || null;
  if ('systemPrompt' in input) data.systemPrompt = input.systemPrompt || null;
  if ('coverLetterPrompt' in input) {
    data.coverLetterPrompt = input.coverLetterPrompt || null;
  }
  if ('apiKey' in input) {
    data.apiKeyEncrypted = input.apiKey ? encryptSecret(input.apiKey) : null;
  }

  await prisma.aiSettings.upsert({
    where: SINGLETON,
    create: { id: 1, ...data },
    update: data,
  });

  return getSettings();
}

/**
 * The provider, model and key a generation should actually use.
 *
 * The async replacement for `resolveAiConfig()` in `providers/index.ts`, which
 * reads the environment alone and stays as the fallback this builds on. Field
 * by field: a stored override wins, then the environment, then the provider's
 * documented default.
 */
export async function resolveAiConfig(): Promise<AiConfig> {
  const row = await readRow();

  const provider = (row?.provider as AiProvider | null) ?? env.AI_PROVIDER;
  const apiKey = decryptSecret(row?.apiKeyEncrypted) ?? envKeyFor(provider);

  if (!apiKey) {
    throw new ServiceUnavailableError(
      `No API key for ${provider}. Set one on the AI Settings screen, or set ` +
        `${KEY_VARIABLE[provider]} in the environment.`,
    );
  }

  return {
    provider,
    apiKey,
    model: row?.model || env.AI_MODEL || DEFAULT_MODEL[provider],
    timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
  };
}

/**
 * The key to list a platform's catalogue with, when the caller supplied none.
 *
 * The stored key first, then the environment's — the same order a generation
 * resolves in, so the picker lists what generation would actually be able to
 * use. Returns undefined rather than throwing: `resolveApiKey` is what turns
 * "no key anywhere" into a 503 naming the variable.
 */
export async function storedApiKeyFor(provider: AiProvider): Promise<string | undefined> {
  const row = await readRow();

  // Only when the stored key belongs to the provider being asked about: a key
  // saved for OpenAI is not an Anthropic key, and sending it would produce a
  // rejection that reads like the key is wrong rather than absent.
  const storedProvider = (row?.provider as AiProvider | null) ?? env.AI_PROVIDER;
  if (storedProvider !== provider) return undefined;

  return decryptSecret(row?.apiKeyEncrypted) ?? undefined;
}

/**
 * The account's own prompts, read here rather than through
 * `user-prompts.service.ts` — that module builds its view on `getSettings`
 * above, and the resolution chain must not import its way back around.
 */
async function ownPrompts(userId: string) {
  return prisma.userAiPrompts.findUnique({
    where: { userId },
    select: { systemPrompt: true, coverLetterPrompt: true },
  });
}

/**
 * The Resume's system prompt in force for one account: the account's own
 * (`user-prompts.service.ts`), then the deployment's, then the built-in
 * default. Without an account — nothing in the app generates without one, but
 * the reader stays callable — the deployment's is the top of the chain.
 */
export async function resolveSystemPrompt(userId?: string): Promise<string> {
  const own = userId ? (await ownPrompts(userId))?.systemPrompt : undefined;
  if (own) return own;
  const row = await readRow();
  return row?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
}

/** The cover letter's system prompt in force, layered the same way. Its own column, its own default. */
export async function resolveCoverLetterPrompt(userId?: string): Promise<string> {
  const own = userId ? (await ownPrompts(userId))?.coverLetterPrompt : undefined;
  if (own) return own;
  const row = await readRow();
  return row?.coverLetterPrompt || DEFAULT_COVER_LETTER_PROMPT;
}
