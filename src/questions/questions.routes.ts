import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../env.js';
import { requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { logger } from '../logger.js';
import { ChatSchema, type ChatInput } from './questions.schemas.js';
import * as questionsService from './questions.service.js';

export const questionsRouter: Router = Router();

questionsRouter.use(requireAuth);

/**
 * Looser than the Resume's generate limiter, because a conversation is many
 * short turns rather than one expensive one — "shorter", "less formal", "try
 * again" are each a request. Thirty a minute is well above a person typing and
 * well below what a loop can spend.
 */
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many messages. Please wait a minute and try again.',
    },
  },
});

/** One SSE frame. The blank line is the terminator, and is not optional. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Continues the conversation about one application, streaming the reply.
 *
 * **Server-sent events rather than JSON**, because the wait is the problem this
 * solves: a paragraph that arrives all at once twenty seconds later reads as a
 * hung page, and the same paragraph arriving a few words at a time reads as an
 * answer being written. The frames are `delta` (a fragment), `done` (the reply
 * is complete) and `error`.
 *
 * **A rejected request is still a status.** A blank message, a missing job
 * description or an unconfigured platform is answered as JSON with a real 4xx
 * or 5xx, because nothing has been written yet — that is what `startChat`
 * resolving before the headers are flushed buys.
 *
 * **A failure *after* the first byte is a frame, not a status.** The headers are
 * long gone by then, so the only honest way to report it is inside the stream —
 * which is why the client must treat "the stream ended without `done`" as a
 * failure rather than as a short answer.
 *
 * **Nothing is stored.** The transcript belongs to the client: it arrives whole
 * on every turn, and is saved with the application as `applicationChat` when the
 * form is saved. That is what lets the drawer work on an application that does
 * not exist yet.
 */
questionsRouter.post(
  '/chat',
  chatLimiter,
  validate({ body: ChatSchema }),
  async (req, res, next) => {
    const input = (req as ValidatedRequest<ChatInput>).valid.body;

    // Everything that can fail before a word is written happens here, while a
    // status line is still available: an unconfigured platform must reach the
    // user as a 503 rather than as a sentence in the conversation saying it.
    let reply: AsyncIterable<string>;
    try {
      reply = await questionsService.startChat(input);
    } catch (error) {
      next(error);
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx and a few CDNs buffer a response until it is complete unless told
    // not to, which would deliver the whole reply at once and defeat all of
    // this. Harmless where nothing is listening for it.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // A reader that goes away — the drawer closed, the tab shut — should stop
    // the generation rather than let it run on and be billed for.
    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });

    try {
      for await (const delta of reply) {
        if (aborted) break;
        res.write(sse('delta', { text: delta }));
      }
      if (!aborted) res.write(sse('done', {}));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'The AI service could not be reached. Please try again.';

      // Logged by the service already; this is the half the user sees.
      if (!aborted) res.write(sse('error', { message }));
    } finally {
      res.end();
    }
  },
);
