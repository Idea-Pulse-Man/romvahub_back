import OpenAI from 'openai';
import { BadGatewayError } from '../../http/errors.js';
import type {
  AiConfig,
  AiPlatform,
  ChatRequest,
  ModelOption,
  StructuredRequest,
} from './index.js';

/**
 * DeepSeek's OpenAI-compatible endpoint.
 *
 * The SDK and the chat/completions shape are OpenAI's; only the host (and the
 * structured-output mode below) differ. Keeping that difference in one file is
 * what stops a DeepSeek-shaped quirk from leaking into the OpenAI adapter.
 */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function client(apiKey: string, timeoutMs: number, maxRetries = 0): OpenAI {
  return new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL, timeout: timeoutMs, maxRetries });
}

/**
 * DeepSeek accepts OpenAI's chat API but only guarantees `json_object` mode,
 * not the schema-bound structured outputs OpenAI's `.parse` helper uses. Ask
 * for a JSON object and let `generateStructured` hold the result to the Zod
 * schema — the same check every other adapter already goes through.
 */
async function generate(config: AiConfig, request: StructuredRequest): Promise<unknown> {
  const openai = client(config.apiKey, config.timeoutMs, 0);

  const completion = await openai.chat.completions.create({
    model: config.model,
    messages: [
      {
        role: 'system',
        content:
          `${request.system}\n\n` +
          `Respond with a single JSON object only — no markdown fences, no commentary.`,
      },
      { role: 'user', content: request.user },
    ],
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new BadGatewayError(`The AI returned an empty ${request.label}.`);
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new BadGatewayError(`The AI returned a ${request.label} that was not valid JSON.`);
  }
}

async function* chat(config: AiConfig, request: ChatRequest): AsyncIterable<string> {
  const openai = client(config.apiKey, config.timeoutMs, 0);

  const stream = await openai.chat.completions.create({
    model: config.model,
    stream: true,
    messages: [
      { role: 'system', content: request.system },
      ...request.messages.map((message) => ({ role: message.role, content: message.content })),
    ],
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

async function listModels(apiKey: string): Promise<ModelOption[]> {
  const openai = client(apiKey, 20_000);

  const models: { id: string; created: number }[] = [];
  for await (const model of openai.models.list()) {
    models.push({ id: model.id, created: model.created });
  }

  return models
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .map(({ id }) => ({ id, displayName: id }));
}

export const deepSeekProvider: AiPlatform = { generate, chat, listModels };
