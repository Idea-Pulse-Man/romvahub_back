import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { BadGatewayError } from '../../http/errors.js';
import type {
  AiConfig,
  AiPlatform,
  ChatRequest,
  ModelOption,
  StructuredRequest,
} from './index.js';

/**
 * A one-page Resume — or a page of answers — is comfortably inside this; the
 * cap only stops a runaway.
 */
const MAX_TOKENS = 16_000;

async function generate(config: AiConfig, request: StructuredRequest): Promise<unknown> {
  // See the note in `openai.ts`: retries inside a single function budget are
  // what turn a slow generation into a killed invocation.
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });

  const message = await client.messages.parse({
    model: config.model,
    max_tokens: MAX_TOKENS,
    system: request.system,
    messages: [{ role: 'user', content: request.user }],
    output_config: { format: zodOutputFormat(request.schema) },
  });

  if (message.stop_reason === 'refusal') {
    throw new BadGatewayError(
      `The AI declined to write this ${request.label}: ` +
        (message.stop_details?.explanation ?? 'no reason given'),
    );
  }
  if (!message.parsed_output) {
    throw new BadGatewayError(`The AI returned an empty ${request.label}.`);
  }

  return message.parsed_output;
}

/** See the note in `openai.ts` on why a stream must not be retried. */
async function* chat(config: AiConfig, request: ChatRequest): AsyncIterable<string> {
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });

  const stream = client.messages.stream({
    model: config.model,
    max_tokens: MAX_TOKENS,
    system: request.system,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  });

  // `.on('text')` would be the other way, but an async iterable is what the
  // interface promises and what the route can hand straight to a response.
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

/**
 * Every model Anthropic lists is a chat model, so there is nothing to filter —
 * the only adapter of the three where that is true. The API already returns
 * them newest first, and each carries a human-readable name.
 */
async function listModels(apiKey: string): Promise<ModelOption[]> {
  const client = new Anthropic({ apiKey, timeout: 20_000 });

  const models: ModelOption[] = [];
  for await (const model of client.models.list()) {
    models.push({ id: model.id, displayName: model.display_name || model.id });
  }

  return models;
}

export const anthropicProvider: AiPlatform = { generate, chat, listModels };
