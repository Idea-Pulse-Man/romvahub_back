/**
 * One structured call to whichever AI platform this deployment is configured
 * for.
 *
 * Everything that is true of *any* generation lives here — resolving the
 * provider, model and key; holding it to the timeout; turning three vendors'
 * failures into one set of messages a user can act on; and checking that what
 * came back is the shape that was asked for. What differs per feature is the
 * schema and the two prompts, which are this function's arguments.
 *
 * It exists because there are now two things the app asks a model to write —
 * the Resume, and the answers to an application's extra questions — and the
 * half of that work which is not the prompt is identical. A second copy of the
 * timeout handling would drift from the first the moment either was touched.
 */
import type { z } from 'zod';
import { BadGatewayError, GatewayTimeoutError } from '../http/errors.js';
import { logger } from '../logger.js';
import { resolveAiConfig } from '../ai-config/ai-config.service.js';
import { loadProvider, type AiProvider } from '../resume/providers/index.js';

/**
 * Whether a thrown thing is "we ran out of time" rather than "it went wrong".
 *
 * Three SDKs, three shapes: OpenAI and Anthropic each raise their own
 * `APIConnectionTimeoutError` (name and status are what identify it without
 * importing both error classes), and an `AbortSignal.timeout()` — which is what
 * the Gemini adapter uses — rejects with a `TimeoutError` DOMException.
 */
function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const name = error.name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  if (/timeout/i.test(name)) return true;

  // The SDKs also surface an aborted request as a plain message on a connection
  // error, which is the only signal in some versions.
  return /timed out|timeout/i.test(error.message);
}

export interface StructuredGeneration<T> {
  /** The shape the answer must take, and the shape it is checked against. */
  schema: z.ZodType<T>;
  /** Names the output format. OpenAI requires one; the others ignore it. */
  name: string;
  /**
   * What is being written, as it should read in a sentence shown to a user:
   * "The AI returned an empty Resume." Lowercase, no article.
   */
  label: string;
  system: string;
  user: string;
}

export interface Generated<T> {
  value: T;
  provider: AiProvider;
  model: string;
}

export async function generateStructured<T>(
  request: StructuredGeneration<T>,
): Promise<Generated<T>> {
  // The admin-editable record, falling back field by field to the environment —
  // see `src/ai-config/ai-config.service.ts`.
  const config = await resolveAiConfig();
  const provider = await loadProvider(config.provider);

  const started = Date.now();
  let raw: unknown;
  try {
    raw = await provider.generate(config, request);
  } catch (error) {
    // A 502 raised by the adapter is already the message we want the user to
    // read; anything else is the SDK's, and says more about our request than
    // theirs, so it is logged here and replaced.
    if (error instanceof BadGatewayError) throw error;

    const elapsed = Date.now() - started;

    // Answered as itself rather than folded into "could not be reached",
    // because the two need different things done about them. This one is not a
    // failure to talk to the platform: the platform was still writing when the
    // budget ran out, and the fixes are a faster model or a longer one.
    if (isTimeout(error)) {
      logger.error(
        { provider: config.provider, model: config.model, ms: elapsed, of: request.label },
        'AI generation timed out',
      );
      throw new GatewayTimeoutError(
        // `max(1, …)` so a sub-second budget — which only a test sets — does
        // not report itself as "within 0 seconds".
        `${config.model} did not finish within ${Math.max(1, Math.round(config.timeoutMs / 1000))} seconds. ` +
          'Choose a faster model on the AI Settings screen, or raise AI_REQUEST_TIMEOUT_MS ' +
          "and the deployment's function timeout together.",
      );
    }

    logger.error(
      { err: error, provider: config.provider, model: config.model, ms: elapsed, of: request.label },
      'AI generation failed',
    );
    throw new BadGatewayError(
      `The AI service could not be reached. Please try again.`,
    );
  }

  // Checked here rather than trusted from the adapter. Two of the three SDKs
  // parse against the schema themselves and one hands back a string, so this is
  // the only place all three are held to the same standard — and a platform
  // that answers in almost the right shape should fail as a bad gateway rather
  // than halfway through whatever consumes it.
  const parsed = request.schema.safeParse(raw);
  if (!parsed.success) {
    logger.error(
      { provider: config.provider, model: config.model, issues: parsed.error.issues },
      'The AI answered in an unexpected shape',
    );
    throw new BadGatewayError(`The AI returned a ${request.label} in an unexpected shape.`);
  }

  logger.info(
    { provider: config.provider, model: config.model, ms: Date.now() - started, of: request.label },
    'AI generation finished',
  );

  return { value: parsed.data, provider: config.provider, model: config.model };
}
