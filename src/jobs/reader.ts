import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * The second way to read a posting, used when the first — fetching the page
 * ourselves — comes back with nothing to show for it.
 *
 * A plain GET fails on exactly the boards people paste most: LinkedIn and
 * Indeed answer 403 to anything that is not a signed-in browser, and Workday
 * and its kind serve an empty shell that only becomes a page once JavaScript
 * runs. A reader service is a headless browser someone else operates: given a
 * URL it loads the page as a browser would and hands back the text as
 * Markdown. The default is Jina's public reader, with `JOB_READER_API_KEY`
 * for the networks it will not serve anonymously; the prefix is
 * `JOB_READER_URL` so a deployment can point at its own, or set it empty to go
 * without.
 *
 * Only ever called with a URL that has already cleared `assertFetchable`, so a
 * private address is refused before anyone else is asked to fetch it.
 */

/** A rendering read is slower than a plain one; this still fits the function's budget. */
const READER_TIMEOUT_MS = 40_000;

/** Below this the reader returned a shell or a sign-in wall, not a posting. */
const MIN_READER_CHARS = 200;

/**
 * What the second attempt waits for: the posting's own heading.
 *
 * A reader loads the page in a browser, but it still has to decide when the
 * page is finished, and for a single-page app its answer can be "now" while
 * the app is still fetching. Paycom's portal comes back as the word
 * "Loading..." and a line telling the reader to enable JavaScript — a shell,
 * discarded here as too short, and the reason a Paycom URL could not be read
 * at all. Asked to wait for an `h1`, the same page renders and answers with
 * the posting.
 *
 * `h1` because it is what a rendered posting has and a shell does not — the
 * role's title. When it never appears the reader waits out `WAIT_SECONDS` and
 * answers with whatever the page did have, so the worst this costs is the
 * wait; it cannot turn a page that reads today into one that does not.
 */
const WAIT_FOR_SELECTOR = 'h1';
const WAIT_SECONDS = 20;

export interface ReaderResult {
  /** Markdown, as the reader produced it. */
  content: string;
  title?: string;
  url?: string;
}

export function readerEnabled(): boolean {
  return env.JOB_READER_URL.trim().length > 0;
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Jina's JSON shape is `{ data: { title, url, content } }`; a self-hosted
 * reader may answer with Markdown in the body and nothing else. Both are read.
 */
function interpret(raw: string, contentType: string | null): ReaderResult | null {
  if (/json/i.test(contentType ?? '')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const data =
      parsed && typeof parsed === 'object' && 'data' in parsed
        ? (parsed as { data: unknown }).data
        : parsed;
    if (!data || typeof data !== 'object') return null;

    const fields = data as Record<string, unknown>;
    const content = typeof fields.content === 'string' ? fields.content : '';
    return {
      content,
      ...(clean(fields.title) ? { title: clean(fields.title) } : {}),
      ...(clean(fields.url) ? { url: clean(fields.url) } : {}),
    };
  }

  return { content: raw };
}

/**
 * `posting` when the reader answered with something long enough to be one,
 * `shell` when it answered with a page that has not finished rendering — the
 * one failure worth asking again about — and `failed` for everything else.
 */
type Attempt =
  | { kind: 'posting'; result: ReaderResult }
  | { kind: 'shell' }
  | { kind: 'failed' };

async function read(url: URL, waitForRender: boolean): Promise<Attempt> {
  const target = `${env.JOB_READER_URL}${url.toString()}`;

  let response: Response;
  try {
    response = await fetch(target, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-return-format': 'markdown',
        ...(waitForRender
          ? { 'x-wait-for-selector': WAIT_FOR_SELECTOR, 'x-timeout': String(WAIT_SECONDS) }
          : {}),
        ...(env.JOB_READER_API_KEY ? { authorization: `Bearer ${env.JOB_READER_API_KEY}` } : {}),
      },
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error, url: url.toString() }, 'job reader fallback failed to connect');
    return { kind: 'failed' };
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    logger.warn({ status: response.status, url: url.toString() }, 'job reader fallback refused');
    return { kind: 'failed' };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    logger.warn({ err: error, url: url.toString() }, 'job reader fallback body unreadable');
    return { kind: 'failed' };
  }

  const result = interpret(raw, response.headers.get('content-type'));
  if (!result) return { kind: 'failed' };
  if (result.content.trim().length < MIN_READER_CHARS) return { kind: 'shell' };

  return { kind: 'posting', result };
}

/**
 * Returns `null` rather than throwing: the reader is a fallback, and the error
 * the user should see when it fails too is the one from the direct read,
 * which names what went wrong with *their* URL.
 *
 * Asked twice at most. The first read is the plain one, which is what nearly
 * every page needs and is the faster of the two. Only a read that came back
 * *too short* is asked again, waiting for the page to render: that is the
 * shape of a single-page app answering before it has finished, and nothing
 * else — a refusal, a timeout or an unreadable body is a second request that
 * would fail the same way.
 */
export async function readViaReader(url: URL): Promise<ReaderResult | null> {
  if (!readerEnabled()) return null;

  const plain = await read(url, false);
  if (plain.kind === 'posting') return plain.result;
  if (plain.kind === 'failed') return null;

  logger.info({ url: url.toString() }, 'job reader answered with a shell; asking it to wait for the page');
  const rendered = await read(url, true);
  return rendered.kind === 'posting' ? rendered.result : null;
}
