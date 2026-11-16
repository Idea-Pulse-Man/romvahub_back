import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { BadGatewayError } from '../../http/errors.js';
import type {
  AiConfig,
  AiPlatform,
  ChatRequest,
  ModelOption,
  StructuredRequest,
} from './index.js';

/**
 * OpenAI lists everything the key can reach — embeddings, speech, images and
 * moderation alongside the chat models. Only the last of those can write a
 * Resume.
 *
 * This excludes the families that cannot rather than listing the ones that can,
 * so a chat model released after this was written still appears. The cost of
 * that choice is that a new *non-chat* family shows up until the pattern is
 * extended, which is the cheaper mistake: a model that should not be in the
 * list is a bad row, a model missing from it is a feature someone cannot use.
 */
const NOT_CHAT =
  /embed|tts|whisper|audio|transcribe|speech|dall-e|image|moderation|realtime|search|similarity|edit|davinci|babbage|ada|curie/i;

async function generate(config: AiConfig, request: StructuredRequest): Promise<unknown> {
  // `maxRetries: 0` is the important half. The SDK retries twice by default, so
  // one slow generation could be attempted three times inside a function that
  // has a single 60-second budget — guaranteeing the runtime kills the whole
  // invocation rather than any one attempt failing cleanly.
  const client = new OpenAI({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });

  const completion = await client.chat.completions.parse({
    model: config.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    response_format: zodResponseFormat(request.schema, request.name),
  });

  const message = completion.choices[0]?.message;

  if (message?.refusal) {
    throw new BadGatewayError(`The AI declined to write this ${request.label}: ${message.refusal}`);
  }
  if (!message?.parsed) {
    throw new BadGatewayError(`The AI returned an empty ${request.label}.`);
  }

  return message.parsed;
}

/**
 * The reply to a conversation, a fragment at a time.
 *
 * `maxRetries: 0` for the reason it is zero everywhere else here — but it
 * matters more on a stream: the SDK cannot replay a response the caller has
 * already begun rendering, so a retry halfway through would restart the answer
 * from the top under the same reader.
 */
async function* chat(config: AiConfig, request: ChatRequest): AsyncIterable<string> {
  const client = new OpenAI({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 0 });

  const stream = await client.chat.completions.create({
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
  // Listing is cheap and fast; the default retries are fine here.
  const client = new OpenAI({ apiKey, timeout: 20_000 });

  const models: { id: string; created: number }[] = [];
  // `list` auto-paginates; OpenAI returns the whole catalogue in one page today,
  // but iterating keeps that true if it stops doing so.
  for await (const model of client.models.list()) {
    if (NOT_CHAT.test(model.id)) continue;
    models.push({ id: model.id, created: model.created });
  }

  // Newest first: the catalogue is long, and the model someone wants is far
  // more often the one released last month than the one released in 2023.
  return models
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .map(({ id }) => ({ id, displayName: id }));
}

export const openAiProvider: AiPlatform = { generate, chat, listModels };
