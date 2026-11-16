import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env } from '../env.js';
import { BadGatewayError, UnprocessableEntityError } from '../http/errors.js';
import { logger } from '../logger.js';

/**
 * Fetching a URL the user typed makes this server an HTTP client on their
 * behalf, which is the classic shape of an SSRF: `http://169.254.169.254/` is a
 * cloud metadata endpoint, and `http://localhost:5432` is our own database.
 * Everything below exists to make that fetch boring — a public, HTML,
 * size-capped, time-capped GET, and nothing else.
 */

/** Two megabytes of markup is far more than any job posting needs. */
const MAX_BYTES = 2_000_000;

/** Budget for the whole attempt, redirects included. */
const TIMEOUT_MS = 12_000;

const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Job boards routinely refuse a request that announces itself as a script, and
 * a refused fetch is indistinguishable to the user from a broken feature. This
 * is the same posture a link unfurler takes: a browser-shaped GET of a page the
 * user is already entitled to read, honouring the site's status codes.
 */
const REQUEST_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/126.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
} as const;

export interface FetchedPage {
  /** After redirects — relative URLs in the document resolve against this. */
  finalUrl: string;
  html: string;
}

export interface FetchOptions {
  /**
   * Ask for, and accept, JSON rather than a page. For the boards whose page is
   * an empty shell but whose own API hands the posting out in the open.
   */
  json?: boolean;
  /**
   * Send this as the body of a POST rather than issuing a GET — for a board
   * whose public API is GraphQL. Only ever used together with `json`.
   */
  body?: string;
}

function ipv4IsPublic(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast and reserved

  return true;
}

function ipv6IsPublic(ip: string): boolean {
  const address = ip.toLowerCase().split('%')[0]!; // drop any zone index

  // An IPv4-mapped address reaches an IPv4 destination, so it is judged as one.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return ipv4IsPublic(mapped[1]!);

  if (address === '::' || address === '::1') return false; // unspecified, loopback
  if (/^f[cd]/.test(address)) return false; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(address)) return false; // fe80::/10 link-local
  if (address.startsWith('ff')) return false; // multicast
  if (address.startsWith('2001:db8')) return false; // documentation

  return true;
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return ipv4IsPublic(ip);
  if (family === 6) return ipv6IsPublic(ip);
  return false;
}

/**
 * Rejects anything that is not a public http(s) URL. DNS is resolved here so a
 * hostname that points at a private address is caught too — `localtest.me`
 * resolves to 127.0.0.1, and that is not an obscure trick.
 *
 * Every address the name resolves to has to be public: accepting a name that
 * answers with one public and one private address would leave which of them
 * gets connected to up to the resolver.
 */
export async function assertFetchable(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnprocessableEntityError('That does not look like a URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnprocessableEntityError('Only http and https job URLs can be opened.');
  }

  // Credentials in a URL are never needed to read a public posting, and they
  // would be forwarded to whatever the redirect chain ends at.
  if (url.username || url.password) {
    throw new UnprocessableEntityError('Job URLs must not contain credentials.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  const addresses = isIP(hostname)
    ? [hostname]
    : await lookup(hostname, { all: true, verbatim: true })
        .then((results) => results.map((result) => result.address))
        .catch(() => {
          throw new BadGatewayError(`Could not resolve ${url.hostname}.`);
        });

  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    if (env.JOB_FETCH_ALLOW_PRIVATE_ADDRESSES && !env.isProduction) {
      logger.warn(
        { hostname: url.hostname, addresses },
        'fetching a job URL at a private address because JOB_FETCH_ALLOW_PRIVATE_ADDRESSES is set',
      );
      return url;
    }
    throw new UnprocessableEntityError(
      'That URL points at a private network address, so it cannot be opened from the server.',
    );
  }

  return url;
}

function decode(bytes: Uint8Array, contentType: string | null): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  for (const encoding of [declared, 'utf-8']) {
    if (!encoding) continue;
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      // An unknown charset label falls through to utf-8.
    }
  }
  return new TextDecoder().decode(bytes);
}

/** Reads the body, stopping at `MAX_BYTES` rather than buffering a whole CDN asset. */
async function readCapped(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const out = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const slice = chunk.subarray(0, out.length - offset);
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return out;
}

/**
 * Redirects are followed by hand rather than by `fetch`, because each hop is a
 * new destination and has to clear `assertFetchable` on its own — a public URL
 * that 302s to `http://127.0.0.1:5432` is exactly what the check is for.
 */
export async function fetchJobPage(rawUrl: string, options: FetchOptions = {}): Promise<FetchedPage> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let target = rawUrl;
  let body = options.body;
  const headers = {
    ...REQUEST_HEADERS,
    ...(options.json ? { accept: 'application/json' } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
  };
  const acceptable = options.json ? /json/i : /text\/html|application\/xhtml|text\/plain|\+xml/i;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertFetchable(target);

    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'manual',
        headers,
        ...(body === undefined ? {} : { body }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new BadGatewayError('That site took too long to respond.');
      }
      throw new BadGatewayError(
        `Could not reach ${url.hostname}: ${error instanceof Error ? error.message : 'request failed'}.`,
      );
    }

    const location = response.headers.get('location');
    if (REDIRECT_STATUSES.has(response.status) && location) {
      await response.body?.cancel().catch(() => {});
      try {
        target = new URL(location, url).toString();
      } catch {
        throw new BadGatewayError('That site redirected to an address that is not a URL.');
      }
      // A browser keeps the method and body only across 307 and 308; the
      // older statuses turn the request into a GET of the new address.
      if (response.status !== 307 && response.status !== 308) body = undefined;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // 401/403 is the common answer from a board that wants a signed-in
      // browser, and it is worth naming — the URL is fine, the fetch is not.
      const hint =
        response.status === 401 || response.status === 403
          ? ' It may require signing in, in which case paste the description instead.'
          : '';
      throw new BadGatewayError(
        `That site answered ${response.status} ${response.statusText || ''}`.trim() + '.' + hint,
      );
    }

    const contentType = response.headers.get('content-type');
    if (contentType && !acceptable.test(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new UnprocessableEntityError(
        `That URL returned ${contentType.split(';')[0]}, not ${options.json ? 'JSON' : 'a web page'}.`,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response);
    } catch (error) {
      if (signal.aborted) throw new BadGatewayError('That site took too long to respond.');
      throw new BadGatewayError(
        `Could not read the page: ${error instanceof Error ? error.message : 'read failed'}.`,
      );
    }

    return { finalUrl: url.toString(), html: decode(bytes, contentType) };
  }

  throw new BadGatewayError('That URL redirected too many times.');
}
