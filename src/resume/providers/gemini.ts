import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { BadGatewayError } from '../../http/errors.js';
import type {
  AiConfig,
  AiPlatform,
  ChatRequest,
  ModelOption,
  StructuredRequest,
} from './index.js';

/**
 * Gemini takes a plain JSON Schema rather than a Zod schema, so the one schema
 * the other two adapters hand over directly is converted here.
 *
 * `$schema` and `additionalProperties` are stripped: the API rejects keywords it
 * does not implement, and both of those are about validating input the model is
 * never given.
 */
function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== '$schema' && key !== 'additionalProperties')
      .map(([key, child]) => [key, toGeminiSchema(child)]),
  );
}

async function generate(config: AiConfig, request: StructuredRequest): Promise<unknown> {
  const client = new GoogleGenAI({ apiKey: config.apiKey });

  const response = await client.models.generateContent({
    model: config.model,
    contents: request.user,
    config: {
      systemInstruction: request.system,
      responseMimeType: 'application/json',
      // Converted per request rather than once at module load: the schema now
      // arrives with the request, and turning one Zod object into JSON Schema
      // is a few microseconds against a call that takes seconds.
      responseJsonSchema: toGeminiSchema(
        z.toJSONSchema(request.schema, { target: 'draft-2020-12', io: 'output' }),
      ),
      // This SDK takes a signal rather than a timeout, and retries nothing by
      // default — so one abort is the whole story here.
      abortSignal: AbortSignal.timeout(config.timeoutMs),
    },
  });

  const text = response.text;
  if (!text) {
    throw new BadGatewayError(`The AI returned an empty ${request.label}.`);
  }

  // Unlike the other two SDKs, this one hands back a string, so the parse is
  // ours to do. Checking it against the schema is not: that happens once, for
  // all three platforms, in `src/ai/generate.ts`.
  try {
    return JSON.parse(text);
  } catch {
    throw new BadGatewayError(`The AI returned a ${request.label} that was not valid JSON.`);
  }
}

/**
 * Gemini calls the two roles `user` and `model`, and takes the system prompt as
 * its own field rather than as a first message — so the history is translated
 * on the way in. Everything else is the same conversation.
 */
async function* chat(config: AiConfig, request: ChatRequest): AsyncIterable<string> {
  const client = new GoogleGenAI({ apiKey: config.apiKey });

  const stream = await client.models.generateContentStream({
    model: config.model,
    contents: request.messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
    config: {
      systemInstruction: request.system,
      abortSignal: AbortSignal.timeout(config.timeoutMs),
    },
  });

  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;
  }
}

/**
 * Google's catalogue includes embedding and image models, and each entry says
 * what it can do — so unlike OpenAI, this filters on a declared capability
 * rather than on a guess about the name. An entry that declares nothing is kept:
 * a missing field is not evidence that a model cannot generate.
 *
 * Ids come back as `models/gemini-2.5-pro`; the prefix is dropped because that
 * is not what `generateContent` is called with.
 */
async function listModels(apiKey: string): Promise<ModelOption[]> {
  const client = new GoogleGenAI({ apiKey });

  const models: ModelOption[] = [];
  for await (const model of await client.models.list({ config: { queryBase: true } })) {
    const actions = model.supportedActions;
    if (actions && !actions.includes('generateContent')) continue;

    const id = (model.name ?? '').replace(/^models\//, '');
    if (!id) continue;

    models.push({ id, displayName: model.displayName || id });
  }

  return models.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export const geminiProvider: AiPlatform = { generate, chat, listModels };
