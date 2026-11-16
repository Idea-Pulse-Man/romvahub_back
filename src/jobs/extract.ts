import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { unescapeMarkup } from './markdown.js';

/**
 * Pulling the posting out of a job page, best source first:
 *
 * 1. **schema.org `JobPosting` JSON-LD.** Most boards publish one, because it
 *    is what puts them in Google's job search. It is the only source that names
 *    the description rather than leaving us to guess at it, so it wins whenever
 *    it is present.
 * 2. **A posting embedded in the page's data.** A company site built on
 *    Next.js (or anything else that ships its data as JSON in the page)
 *    renders the posting in the browser from an object the server already put
 *    in a `<script>` — typically the Greenhouse job it fetched, title, content
 *    and location. The rendered DOM says "Loading…"; the JSON says everything.
 * 3. **A known container.** The handful of boards below account for most of
 *    what this app's users paste, and their markup is stable enough to name.
 * 4. **The densest block of text on the page.** A small readability: score
 *    every block by how much of its text is not inside a link, and take the
 *    winner. Navigation and footers are nearly all link text, so they lose.
 * 5. **The whole page.** When no single block is big enough, the page as a
 *    whole may still be — a posting written as bare paragraphs under `<body>`,
 *    with nothing wrapping it. Better the page with its furniture than
 *    nothing: the user is about to edit it anyway.
 */

export interface ExtractedJob {
  title?: string;
  /**
   * `posting` when `title` came from a source that names the role itself —
   * JSON-LD, a board's API. `page` when it is the document's `<title>` or
   * `og:title`, which also tends to carry the company, the location and the
   * board, and is taken apart downstream (see `metadata.ts`).
   */
  titleSource?: 'posting' | 'page';
  /**
   * The document `<title>` when `title` came from somewhere else. Greenhouse
   * puts only the role in `og:title` and "Job Application for Role at Company"
   * in `<title>`, so the second still has something the first lacks.
   */
  pageTitle?: string;
  /** The employer, from JSON-LD only. `og:site_name` is exposed separately, because it is the board as often as the employer. */
  company?: string;
  siteName?: string;
  location?: string;
  employmentType?: string;
  datePosted?: string;
  /** HTML when it came from markup, plain text when JSON-LD supplied text. */
  description?: string;
  /** Which of the strategies produced `description`. */
  strategy: 'board' | 'json-ld' | 'page-data' | 'container' | 'readability' | 'page' | 'none';
}

/** Anything that is never part of a posting, removed before any text is scored. */
const NOISE =
  'script, style, noscript, template, svg, canvas, iframe, form, button, input, select, ' +
  'textarea, [aria-hidden="true"], [role="navigation"], [hidden], ' +
  // A call to action written as a link rather than a `<button>`: Paylocity's
  // "Apply" is an `<a>` with a button's classes, and it sits inside the block
  // holding the description, so nothing above this line would have caught it.
  'a[role="button"], [class*="apply-btn" i], [class*="apply-button" i], [class*="btn-apply" i], ' +
  // Cookie-consent overlays. They sit at the end of the body, out of the way
  // of the posting, and in text they are a page in their own right.
  '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #CybotCookiebotDialog, ' +
  '#cookie-banner, #cookieBanner, #cookie-consent, #cookieConsent, .cc-window, .cc-banner, ' +
  '[class*="cookie-banner" i], [class*="cookie-consent" i], [class*="cookieconsent" i], ' +
  '[class*="cookie-notice" i], [id*="cookie-notice" i], [aria-label*="cookie" i], ' +
  '[role="alertdialog"]';

/** Structural chrome. Stripped only for the guessing strategies, never inside JSON-LD. */
const CHROME = 'nav, aside, header, footer, [role="banner"], [role="contentinfo"]';

/**
 * Ordered most specific first. The generic attribute matches at the end are
 * what catch the boards not named here, which is most of them.
 */
const CONTAINERS = [
  '[data-testid="jobDescriptionText"]', // Indeed
  '#jobDescriptionText', // Indeed
  '.jobs-description__content', // LinkedIn, signed in
  '.description__text', // LinkedIn, public
  '#job-details',
  '[data-automation-id="jobPostingDescription"]', // Workday
  '[data-qa="job-description"]', // SmartRecruiters
  '.job__description', // Greenhouse
  '.job-preview-details', // Paylocity
  '.job-description',
  '#job-description',
  '.posting-page .section-wrapper', // Lever
  '[data-ui="job-description"]', // Ashby
  '[class*="jobDescription"]',
  '[class*="job-description"]',
  '[id*="job-description"]',
  '[class*="JobDescription"]',
  '#content', // Greenhouse
  'article',
  'main',
  '[role="main"]',
];

/** Below this a "description" is a heading or a cookie banner, not a posting. */
const MIN_DESCRIPTION_CHARS = 200;

/**
 * The floor for taking the whole page. Lower than the one for a block, because
 * by this point the choice is between a short page and nothing — but not zero,
 * since a JavaScript shell's "Loading…" or "enable JavaScript to continue" is
 * a page with text and still not a posting.
 */
const MIN_PAGE_CHARS = 100;

function text(node: Cheerio<AnyNode>): string {
  return node.text().replace(/\s+/g, ' ').trim();
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** `@type` may be a string or an array, and casing is not guaranteed. */
function hasType(node: Record<string, unknown>, type: string): boolean {
  const raw = node['@type'];
  const types = Array.isArray(raw) ? raw : [raw];
  return types.some((value) => typeof value === 'string' && value.toLowerCase() === type);
}

/** Flattens the shapes JSON-LD blocks come in: a node, an array, or an `@graph`. */
function flattenLd(value: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 4 || value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) flattenLd(item, out, depth + 1);
    return;
  }

  const node = value as Record<string, unknown>;
  out.push(node);
  if ('@graph' in node) flattenLd(node['@graph'], out, depth + 1);
}

function findJobPosting($: CheerioAPI): Record<string, unknown> | null {
  const nodes: Record<string, unknown>[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).text().trim();
    if (!raw) return;
    try {
      flattenLd(JSON.parse(raw), nodes);
    } catch {
      // Hand-assembled JSON-LD is often invalid. Skip the block, keep the page.
    }
  });

  return nodes.find((node) => hasType(node, 'jobposting')) ?? null;
}

/** `{ "@type": "Organization", "name": "Acme" }`, or occasionally just `"Acme"`. */
function namedValue(value: unknown): string | undefined {
  if (typeof value === 'string') return clean(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return clean((value as Record<string, unknown>).name);
  }
  return undefined;
}

function formatLocation(posting: Record<string, unknown>): string | undefined {
  const raw = posting.jobLocation;
  const first = Array.isArray(raw) ? raw[0] : raw;

  const parts: (string | undefined)[] = [];
  if (first && typeof first === 'object') {
    const address = (first as Record<string, unknown>).address;
    if (address && typeof address === 'object') {
      const fields = address as Record<string, unknown>;
      parts.push(
        clean(fields.addressLocality),
        clean(fields.addressRegion),
        namedValue(fields.addressCountry),
      );
    }
  }

  const located = parts.filter(Boolean).join(', ');
  const remote = posting.jobLocationType === 'TELECOMMUTE';

  if (remote) return located ? `Remote, ${located}` : 'Remote';
  return located || undefined;
}

/**
 * `employmentType` is `"FULL_TIME"`, a list of those, or an object holding
 * both a code and a label — Rippling's is
 * `{ label: "SALARIED_FT", id: "Salaried, full-time" }`, with the readable one
 * under the key you would expect to hold the code. Which of an object's
 * strings is meant for a person is not something its key names can be trusted
 * for, so the one written as words wins over the one written as a token.
 */
export function formatEmploymentType(value: unknown): string | undefined {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (() => {
          const strings = Object.values(value as Record<string, unknown>).filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0,
          );
          return strings.find((item) => /\s/.test(item.trim())) ?? strings[0];
        })()
      : value;

  const values = (Array.isArray(source) ? source : [source]).filter(
    (item): item is string => typeof item === 'string',
  );
  if (values.length === 0) return undefined;

  return values
    .map((item) =>
      item
        .split(/[_\s]+/)
        .filter(Boolean)
        .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
        .join(' '),
    )
    .join(', ');
}

/** `2026-03-01T00:00:00Z` and `2026-03-01` both become `2026-03-01`. */
function toDateOnly(value: unknown): string | undefined {
  const raw = clean(value);
  const match = raw && /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match ? match[1] : undefined;
}

/** The keys a posting's body travels under in a page's own data. */
const EMBEDDED_BODY_KEYS = ['content', 'descriptionHtml', 'description_html', 'description', 'jobDescription', 'job_description', 'body'];

/** And the keys its role travels under. Rippling's job object calls it `name`. */
const EMBEDDED_TITLE_KEYS = ['title', 'name'];

/** And the keys the day it went up travels under. Rippling's is `createdOn`. */
const EMBEDDED_DATE_KEYS = [
  'datePosted',
  'date_posted',
  'first_published',
  'published_at',
  'publishedAt',
  'postedAt',
  'posted_at',
  'createdOn',
  'created_at',
];

/**
 * Branches of a page's data that are never a posting, however much they look
 * like one. A translation store is the dangerous case: it holds the UI's own
 * strings under exactly the shape looked for here — a short `title` beside a
 * long `description` — and a Rippling page's store carries a consent notice
 * headed "{{companyName}} uses AI to analyze applications", which is what the
 * parser took for the role.
 */
const EMBEDDED_SKIP_KEYS = new Set([
  '_nexti18next',
  'i18n',
  'initiali18nstore',
  'translations',
  'translation',
  'messages',
  'locales',
  'localization',
  'dictionaries',
]);

/**
 * A string still holding a template's placeholder — `{{companyName}}`,
 * `${role}`, `%{count}` — was written to be filled in and never was, which
 * makes it a UI string rather than anything a posting says.
 */
const UNRENDERED_PLACEHOLDER = /\{\{[^}]*\}\}|\$\{[^}]*\}|%\{[^}]*\}/;

/** How far into a page's data the search goes: deep enough for `props.pageProps.jobData`, cheap enough for a whole site's navigation tree. */
const EMBEDDED_MAX_DEPTH = 10;
const EMBEDDED_MAX_NODES = 50_000;

interface EmbeddedPosting {
  title: string;
  description: string;
  company?: string;
  location?: string;
  employmentType?: string;
  datePosted?: string;
}

function stringField(node: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = clean(node[key]);
    if (value) return value;
  }
  return undefined;
}

/** How long a piece of a split description has to be to be one of its sections rather than a label. */
const MIN_SECTION_CHARS = 40;

/**
 * A posting's body, which is usually one string and sometimes an object of
 * them: Rippling splits its description into `{ company, role }`, two pieces
 * of HTML the page prints one after the other. The pieces are joined in the
 * order they are written, and only when one of them is long enough to be a
 * section of a posting — otherwise any object of short labels would qualify.
 */
function embeddedBody(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const sections = Object.values(raw as Record<string, unknown>).filter(
    (value): value is string => typeof value === 'string' && value.trim().length >= MIN_SECTION_CHARS,
  );
  if (sections.length === 0) return undefined;
  if (!sections.some((section) => section.replace(/<[^>]*>/g, '').trim().length >= MIN_DESCRIPTION_CHARS)) {
    return undefined;
  }
  return sections.join('\n');
}

/**
 * Whether one object of a page's data is a posting: a short title beside a
 * body long enough to be one. Greenhouse's job object (`title`, `content`,
 * `location.name`) is the common shape, but nothing here is specific to it.
 */
function asEmbeddedPosting(node: Record<string, unknown>): EmbeddedPosting | null {
  const title = stringField(node, ...EMBEDDED_TITLE_KEYS);
  if (!title || title.length > 200 || UNRENDERED_PLACEHOLDER.test(title)) return null;

  for (const key of EMBEDDED_BODY_KEYS) {
    const raw = embeddedBody(node[key]);
    if (raw === undefined) continue;
    const description = unescapeMarkup(raw);
    if (description.replace(/<[^>]*>/g, '').trim().length < MIN_DESCRIPTION_CHARS) continue;

    const location = node.location;
    const offices = node.offices;
    const workLocations = node.workLocations;
    const locationName =
      (location && typeof location === 'object' ? clean((location as Record<string, unknown>).name) : clean(location)) ??
      (Array.isArray(offices) && offices[0] && typeof offices[0] === 'object'
        ? clean((offices[0] as Record<string, unknown>).name)
        : undefined) ??
      (Array.isArray(workLocations) ? clean(workLocations[0]) : undefined);
    const organisation = node.hiringOrganization ?? node.company;
    const company =
      stringField(node, 'company_name', 'companyName', 'employer') ??
      (organisation && typeof organisation === 'object' ? clean((organisation as Record<string, unknown>).name) : clean(organisation));

    return {
      title,
      description,
      ...(company ? { company } : {}),
      ...(locationName ? { location: locationName } : {}),
      ...(formatEmploymentType(node.employmentType ?? node.employment_type)
        ? { employmentType: formatEmploymentType(node.employmentType ?? node.employment_type) as string }
        : {}),
      ...(toDateOnly(stringField(node, ...EMBEDDED_DATE_KEYS))
        ? { datePosted: toDateOnly(stringField(node, ...EMBEDDED_DATE_KEYS)) as string }
        : {}),
    };
  }
  return null;
}

/**
 * The posting in the page's own data, when the page carries any: Next.js's
 * `__NEXT_DATA__`, or any other `<script type="application/json">`. Walked
 * breadth-first so the shallowest posting wins — on a job page that is the
 * job, not a "related roles" list further down.
 */
function findEmbeddedPosting($: CheerioAPI): EmbeddedPosting | null {
  const roots: unknown[] = [];
  $('script#__NEXT_DATA__, script[type="application/json"]').each((_, element) => {
    const raw = $(element).text().trim();
    if (!raw || raw.length > 5_000_000) return;
    try {
      roots.push(JSON.parse(raw));
    } catch {
      // Not JSON after all; the next script may be.
    }
  });

  const queue: { node: unknown; depth: number }[] = roots.map((node) => ({ node, depth: 0 }));
  let visited = 0;
  while (queue.length > 0 && visited < EMBEDDED_MAX_NODES) {
    const { node, depth } = queue.shift()!;
    visited += 1;
    if (node === null || typeof node !== 'object') continue;

    if (!Array.isArray(node)) {
      const posting = asEmbeddedPosting(node as Record<string, unknown>);
      if (posting) return posting;
    }
    if (depth >= EMBEDDED_MAX_DEPTH) continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (child && typeof child === 'object') queue.push({ node: child, depth: depth + 1 });
      }
      continue;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (EMBEDDED_SKIP_KEYS.has(key.toLowerCase())) continue;
      if (child && typeof child === 'object') queue.push({ node: child, depth: depth + 1 });
    }
  }
  return null;
}

function metaContent($: CheerioAPI, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const value = clean($(selector).first().attr('content'));
    if (value) return value;
  }
  return undefined;
}

/**
 * A block's score is its text length minus the text inside its links, tripled.
 * A posting is mostly prose; a nav or a "related jobs" rail is mostly anchors,
 * and the multiplier is what keeps a long rail from outscoring a short posting.
 */
function densestBlock($: CheerioAPI): Cheerio<AnyNode> | null {
  let best: Cheerio<AnyNode> | null = null;
  let bestScore = 0;

  $('div, section, article, td, li').each((_, element) => {
    const node = $(element);
    const length = text(node).length;
    if (length < MIN_DESCRIPTION_CHARS) return;

    const linkLength = text(node.find('a')).length;
    const score = length - linkLength * 3;

    // `>=` deliberately: on a tie the later element is the deeper or
    // later-in-document one, which is the tighter fit around the same text.
    if (score >= bestScore && score > 0) {
      bestScore = score;
      best = node;
    }
  });

  return best;
}

/** Rewrites relative `href`s so a link still works once it leaves the page. */
function absolutise($: CheerioAPI, root: Cheerio<AnyNode>, baseUrl: string): void {
  root.find('a[href]').each((_, element) => {
    const link = $(element);
    const href = link.attr('href');
    if (!href) return;
    try {
      link.attr('href', new URL(href, baseUrl).toString());
    } catch {
      link.removeAttr('href');
    }
  });
}

export function extractJobPosting(html: string, baseUrl: string): ExtractedJob {
  const $ = cheerio.load(html);

  // Read JSON-LD first: the noise sweep below removes the `<script>` it lives in.
  const posting = findJobPosting($);

  const pageTitle = clean($('title').first().text());
  const ogTitle = metaContent($, ['meta[property="og:title"]', 'meta[name="twitter:title"]']);
  const siteName = metaContent($, ['meta[property="og:site_name"]']);

  const postingTitle = clean(posting?.title);
  const title = postingTitle ?? ogTitle ?? pageTitle;
  const result: ExtractedJob = {
    title,
    ...(title ? { titleSource: postingTitle ? 'posting' : 'page' } : {}),
    ...(pageTitle && pageTitle !== title ? { pageTitle } : {}),
    company: namedValue(posting?.hiringOrganization),
    siteName,
    location: posting ? formatLocation(posting) : undefined,
    employmentType: formatEmploymentType(posting?.employmentType),
    datePosted: toDateOnly(posting?.datePosted),
    strategy: 'none',
  };

  // Decoded here rather than only in `toMarkdown`, so that the links inside a
  // description that arrived escaped are still resolved below.
  const ldDescription = typeof posting?.description === 'string' ? unescapeMarkup(posting.description) : '';
  if (ldDescription.trim().length >= MIN_DESCRIPTION_CHARS) {
    // JSON-LD descriptions are HTML often enough to be worth resolving links in,
    // and harmless to run through cheerio when they are plain text.
    const fragment = cheerio.load(ldDescription, null, false);
    absolutise(fragment, fragment.root(), baseUrl);
    return { ...result, description: fragment.html(), strategy: 'json-ld' };
  }

  // The page's own data, before the noise sweep removes the <script> it is in.
  const embedded = findEmbeddedPosting($);
  if (embedded) {
    const fragment = cheerio.load(embedded.description, null, false);
    absolutise(fragment, fragment.root(), baseUrl);
    return {
      ...result,
      title: embedded.title,
      titleSource: 'posting',
      ...(pageTitle && pageTitle !== embedded.title ? { pageTitle } : {}),
      company: result.company ?? embedded.company,
      location: result.location ?? embedded.location,
      employmentType: result.employmentType ?? embedded.employmentType,
      datePosted: result.datePosted ?? embedded.datePosted,
      description: fragment.html(),
      strategy: 'page-data',
    };
  }

  $(NOISE).remove();

  for (const selector of CONTAINERS) {
    const node = $(selector).first();
    if (node.length === 0) continue;
    if (text(node).length < MIN_DESCRIPTION_CHARS) continue;

    node.find(CHROME).remove();
    absolutise($, node, baseUrl);
    return { ...result, description: $.html(node), strategy: 'container' };
  }

  $(CHROME).remove();

  const block = densestBlock($);
  if (block) {
    absolutise($, block, baseUrl);
    return { ...result, description: $.html(block), strategy: 'readability' };
  }

  const body = $('body').first();
  if (body.length > 0 && text(body).length >= MIN_PAGE_CHARS) {
    absolutise($, body, baseUrl);
    return { ...result, description: body.html() ?? '', strategy: 'page' };
  }

  return result;
}
