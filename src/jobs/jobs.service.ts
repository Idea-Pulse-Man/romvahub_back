import { UnprocessableEntityError } from '../http/errors.js';
import { tidyCompanyName } from '../domain/company.js';
import { logger } from '../logger.js';
import { readKnownBoard } from './boards.js';
import { assertFetchable, fetchJobPage } from './fetch-page.js';
import { extractJobPosting, type ExtractedJob } from './extract.js';
import { tidyMarkdown, toMarkdown, type MarkdownResult } from './markdown.js';
import { refineMetadata } from './metadata.js';
import { readViaReader } from './reader.js';

export interface ParsedJob {
  /** The URL actually read, after redirects. */
  url: string;
  /** The posting, as Markdown, ready for the form's description editor. */
  description: string;
  /** True when the posting exceeded the length cap and was cut short. */
  truncated: boolean;
  /** Where the description came from — useful when a result looks wrong. */
  strategy: ExtractedJob['strategy'] | 'reader';
  title?: string;
  company?: string;
  location?: string;
  employmentType?: string;
  datePosted?: string;
}

type Metadata = Omit<ParsedJob, 'url' | 'description' | 'truncated' | 'strategy'>;

/**
 * The title and company, cleaned up (see `metadata.ts`), plus the fields that
 * need no cleaning. `otherTitles` are candidates behind the extracted one — the
 * reader's, on that path — and are only consulted when the extracted title is
 * a page title rather than the posting's own, or is missing.
 */
function metadata(
  extracted: ExtractedJob | undefined,
  markdown: string,
  url: string,
  otherTitles: (string | undefined)[] = [],
): Metadata {
  const structured = extracted?.titleSource === 'posting';
  const { title, company } = refineMetadata({
    // A shell page's `<title>` ("Recruitment") ranks below what a reader saw;
    // a posting's own title ranks above everything. The document `<title>`
    // comes last: it is the wordiest, but on Greenhouse it is the only place
    // the company is written.
    titles: structured
      ? [extracted?.title, ...otherTitles, extracted?.pageTitle]
      : [...otherTitles, extracted?.title, extracted?.pageTitle],
    structured,
    company: extracted?.company,
    siteName: extracted?.siteName,
    markdown,
    url,
  });

  return {
    ...(title ? { title } : {}),
    // "Acme, Inc." is stored as "Acme", so one employer reads one way in the list.
    ...(company ? { company: tidyCompanyName(company) } : {}),
    ...(extracted?.location ? { location: extracted.location } : {}),
    ...(extracted?.employmentType ? { employmentType: extracted.employmentType } : {}),
    ...(extracted?.datePosted ? { datePosted: extracted.datePosted } : {}),
  };
}

/**
 * Fetch a job posting and return it as Markdown.
 *
 * Three reads, in order. A board we know to serve an empty shell is asked for
 * the posting through its own API first (`boards.ts`). Otherwise the direct
 * read fetches the page from here and looks for the posting in it; it is
 * fast, cheap, and enough for most boards. When it
 * comes back empty-handed — the site refused, timed out, sent a PDF, or sent a
 * page with no posting in it — the same URL goes to the reader service, which
 * loads it in a real browser and returns the text. Only when both fail does the
 * user see an error, and it is the direct read's, because that one names what
 * went wrong with the URL they typed.
 *
 * The one thing that skips the fallback is a URL that must not be fetched at
 * all: not http(s), or pointing at a private address. Nobody is asked to fetch
 * that on our behalf.
 *
 * Nothing here is stored: the result is a draft handed back to the form, and it
 * becomes a bid only if the user saves one. That is deliberate — extraction is
 * a guess, and the user is the one who can tell whether the guess is right.
 */
export async function parseJobUrl(rawUrl: string): Promise<ParsedJob> {
  const url = await assertFetchable(rawUrl);

  let extracted: ExtractedJob | undefined = (await readKnownBoard(url)) ?? undefined;
  let finalUrl = url.toString();
  let directFailure: unknown;

  if (!extracted) {
    try {
      const page = await fetchJobPage(finalUrl);
      finalUrl = page.finalUrl;
      extracted = extractJobPosting(page.html, finalUrl);
    } catch (error) {
      directFailure = error;
    }
  }

  if (extracted?.description) {
    const { markdown, truncated } = toMarkdown(extracted.description);
    if (markdown.length > 0) {
      return {
        url: finalUrl,
        description: markdown,
        truncated,
        strategy: extracted.strategy,
        ...metadata(extracted, markdown, finalUrl),
      };
    }
  }

  const viaReader = await readViaReader(url);
  if (viaReader) {
    const { markdown, truncated }: MarkdownResult = tidyMarkdown(viaReader.content);
    if (markdown.length > 0) {
      logger.info(
        { url: finalUrl, direct: directFailure instanceof Error ? directFailure.message : 'no description' },
        'job posting read through the reader service',
      );
      return {
        url: viaReader.url ?? finalUrl,
        description: markdown,
        truncated,
        strategy: 'reader',
        // The direct read may have found JSON-LD metadata even when the
        // description was missing; that outranks the reader's title. A bare
        // page title does not — on a JavaScript shell it is the app's name.
        ...metadata(extracted, markdown, viaReader.url ?? finalUrl, [viaReader.title]),
      };
    }
  }

  if (directFailure) throw directFailure;

  throw new UnprocessableEntityError(
    'No job description could be found on that page. Some boards only render the posting ' +
      'after signing in — paste the description instead.',
  );
}
