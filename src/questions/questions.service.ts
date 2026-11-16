/**
 * The conversation held beside one application.
 *
 * Unlike the Resume, this does not go through `src/ai/generate.ts`: there is no
 * schema to hold the answer to and nothing to validate, and the reply is wanted
 * in pieces rather than whole. What it shares is everything about *reaching* a
 * platform — the config, the key, the timeout — so it resolves the same way.
 */
import { BadGatewayError } from '../http/errors.js';
import { logger } from '../logger.js';
import { toMarkdown } from '../jobs/markdown.js';
import { resolveAiConfig } from '../ai-config/ai-config.service.js';
import { loadProvider, type ChatMessage } from '../resume/providers/index.js';
import { buildChatSystemPrompt, buildContext } from './prompt.js';
import type { ChatInput } from './questions.schemas.js';

/**
 * The conversation as the platform is given it: the application, then
 * everything that has been said about it.
 *
 * The context is folded into the *first user message* rather than sent as a
 * separate turn, because a conversation that opens with a wall of job
 * description and no question invites the model to reply to it. Attached to the
 * first question, it reads as what it is — "here is the application, and here
 * is what I am asking about it".
 */
export function buildConversation(input: ChatInput): ChatMessage[] {
  // The description arrives as the sanitised HTML the editor stores. Markdown
  // is cheaper in tokens and easier for a model to read as structure — the same
  // conversion the Resume's own prompt does, for the same reason.
  const { markdown } = toMarkdown(input.jobDescription);
  const context = buildContext({ ...input, jobDescription: markdown || input.jobDescription });

  return input.messages.map((message, index) =>
    index === 0 && message.role === 'user'
      ? { role: 'user' as const, content: `${context}\n\n---\n\n${message.content}` }
      : message,
  );
}

/**
 * Opens a conversation turn, and answers with the reply as it arrives.
 *
 * Two phases, deliberately. Everything that can be known to fail *before* a
 * word is written — no API key, no such provider — happens in the awaited part,
 * so the route can still answer with a real status. Only once this resolves is
 * anything committed to the wire, and from that point a failure can only be
 * reported inside the stream.
 *
 * Nothing is stored here. The transcript belongs to the client, which sends it
 * whole on every turn and saves it with the application — see the route.
 */
export async function startChat(input: ChatInput): Promise<AsyncIterable<string>> {
  const config = await resolveAiConfig();
  const provider = await loadProvider(config.provider);
  const messages = buildConversation(input);

  return (async function* stream() {
    const started = Date.now();
    let characters = 0;

    try {
      for await (const delta of provider.chat(config, {
        system: buildChatSystemPrompt(),
        messages,
      })) {
        characters += delta.length;
        yield delta;
      }
    } catch (error) {
      logger.error(
        { err: error, provider: config.provider, model: config.model, ms: Date.now() - started },
        'The conversation failed mid-reply',
      );

      // Raised rather than swallowed, but the route has to decide what to do
      // with it: once bytes are on the wire the status line is long gone, so a
      // failure halfway through is a message in the stream rather than a 502.
      throw new BadGatewayError(
        'The AI service stopped replying. Ask again — anything already written is kept.',
      );
    }

    logger.info(
      {
        provider: config.provider,
        model: config.model,
        ms: Date.now() - started,
        turns: input.messages.length,
        characters,
      },
      'Conversation turn finished',
    );
  })();
}
