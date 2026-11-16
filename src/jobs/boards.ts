import { BadGatewayError } from '../http/errors.js';
import { logger } from '../logger.js';
import { formatEmploymentType, type ExtractedJob } from './extract.js';
import { fetchJobPage } from './fetch-page.js';

/**
 * Boards whose job page is an empty shell — nothing but a `<div id="app">`
 * until JavaScript runs — but which hand the same posting out through an
 * unauthenticated JSON endpoint the page itself calls. Reading that endpoint
 * is faster and cleaner than rendering the page in a headless browser: the
 * description arrives as the posting's own HTML, with no cookie banner, share
 * buttons or "Powered by" footer around it.
 *
 * Each adapter answers `null` when the URL is not one of its own. Anything
 * else it throws is swallowed by the caller, because a board API that changes
 * shape should degrade to the general path, not to an error.
 */

interface BoardAdapter {
  name: string;
  read(url: URL): Promise<ExtractedJob | null>;
}

function stringAt(value: unknown, ...path: (string | number)[]): string | undefined {
  let node: unknown = value;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  if (typeof node !== 'string') return undefined;
  const trimmed = node.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

/**
 * ADP WorkforceNow. The public URL is
 * `…/mascsr/default/mdf/recruitment/recruitment.html?cid=…&ccId=…&jobId=…`
 * and the page it serves is titled "Recruitment" with no posting in it. The
 * page's own script loads the requisition from
 * `…/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/{jobId}`,
 * which is what is read here. The requisition names the title, location,
 * posting date and description; it does not name the employer — ADP hosts
 * thousands of them under one domain, and the client's name lives in a
 * separate branding call that is not public. The company is left for the
 * description to reveal (see `metadata.ts`).
 */
const adpWorkforceNow: BoardAdapter = {
  name: 'adp-workforcenow',
  async read(url) {
    if (!/(^|\.)workforcenow\.adp\.com$/i.test(url.hostname)) return null;
    if (!/\/mascsr\/default\/mdf\/recruitment\//i.test(url.pathname)) return null;

    const cid = url.searchParams.get('cid');
    const ccId = url.searchParams.get('ccId');
    const jobId = url.searchParams.get('jobId');
    if (!cid || !ccId || !jobId || !/^\d+$/.test(jobId)) return null;

    const api = new URL(
      `/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/${jobId}`,
      url.origin,
    );
    api.searchParams.set('cid', cid);
    api.searchParams.set('ccId', ccId);
    api.searchParams.set('lang', url.searchParams.get('lang') ?? 'en_US');

    const page = await fetchJobPage(api.toString(), { json: true });

    let requisition: unknown;
    try {
      requisition = JSON.parse(page.html);
    } catch {
      throw new BadGatewayError('ADP answered with something that is not JSON.');
    }

    const description = stringAt(requisition, 'requisitionDescription');
    if (!description) return null;

    const location =
      stringAt(requisition, 'requisitionLocations', 0, 'nameCode', 'shortName') ??
      [
        stringAt(requisition, 'requisitionLocations', 0, 'address', 'cityName'),
        stringAt(requisition, 'requisitionLocations', 0, 'address', 'countrySubdivisionLevel1', 'codeValue'),
      ]
        .filter(Boolean)
        .join(', ');

    const postDate = stringAt(requisition, 'postDate');
    const datePosted = postDate && /^\d{4}-\d{2}-\d{2}/.exec(postDate)?.[0];

    return {
      title: stringAt(requisition, 'requisitionTitle'),
      titleSource: 'posting',
      ...(location ? { location } : {}),
      ...(datePosted ? { datePosted } : {}),
      description,
      strategy: 'board',
    };
  },
};

/**
 * What the Gem job board's page asks its API for, minus the application-form
 * fields the page also needs and we do not. The posting is split across three
 * HTML fields: a board-wide intro and outro the employer writes once, around
 * the description of this role. Compensation, when set, is a fourth.
 */
const GEM_QUERY = `query ExternalJobPosting($boardId: String!, $extId: String!) {
  oatsExternalJobPosting(boardId: $boardId, extId: $extId) {
    title
    descriptionHtml
    firstPublishedTsSec
    locations { name city isoCountry isRemote }
    job {
      locationType
      employmentType
      locations { name city isoCountry isRemote }
    }
    jobPostSectionHtml { introHtml outroHtml }
    compensationHtml
  }
}`;

/**
 * Gem. The public URL is `jobs.gem.com/{board}/{postId}` and the page it serves
 * is an empty `<div id="content">` titled "{Company} Careers". The page's
 * script asks `jobs.gem.com/api/public/graphql` for the posting, anonymously,
 * and that is what is read here. The posting names the title, locations,
 * employment type and first-published date; the employer's name is only in
 * the URL (the board slug) and, usually, the intro — both of which
 * `metadata.ts` already reads.
 */
const gem: BoardAdapter = {
  name: 'gem',
  async read(url) {
    if (!/^jobs\.gem\.com$/i.test(url.hostname)) return null;

    const [board, postId, ...rest] = url.pathname.split('/').filter(Boolean);
    if (!board || !postId || rest.length > 0) return null;
    if (!/^[\w-]+$/.test(board) || !/^[\w-]+$/.test(postId)) return null;

    const page = await fetchJobPage(new URL('/api/public/graphql', url.origin).toString(), {
      json: true,
      body: JSON.stringify({
        operationName: 'ExternalJobPosting',
        variables: { boardId: board, extId: postId },
        query: GEM_QUERY,
      }),
    });

    let answer: unknown;
    try {
      answer = JSON.parse(page.html);
    } catch {
      throw new BadGatewayError('Gem answered with something that is not JSON.');
    }

    const posting = (answer as { data?: { oatsExternalJobPosting?: unknown } }).data?.oatsExternalJobPosting;
    if (!posting || typeof posting !== 'object') return null;

    const html = (field: string) => {
      const value = stringAt(posting, ...field.split('.'));
      return value && value.replace(/<[^>]*>/g, '').trim() ? value : undefined;
    };
    const body = html('descriptionHtml');
    if (!body) return null;

    const description = [html('jobPostSectionHtml.introHtml'), body, html('compensationHtml'), html('jobPostSectionHtml.outroHtml')]
      .filter(Boolean)
      .join('\n');

    const job = (posting as { job?: unknown }).job;
    const rawLocations = (posting as { locations?: unknown }).locations ?? (job as { locations?: unknown } | null)?.locations;
    const places = (Array.isArray(rawLocations) ? rawLocations : [])
      .map(
        (place) =>
          stringAt(place, 'name') ??
          [stringAt(place, 'city'), stringAt(place, 'isoCountry')].filter(Boolean).join(', '),
      )
      .filter(Boolean);
    const remote =
      stringAt(job, 'locationType')?.toUpperCase() === 'REMOTE' ||
      (Array.isArray(rawLocations) && rawLocations.some((place) => (place as { isRemote?: unknown })?.isRemote === true));
    const location = remote ? ['Remote', ...places].join(', ') : places.join(', ');

    const published = (posting as { firstPublishedTsSec?: unknown }).firstPublishedTsSec;
    const datePosted =
      typeof published === 'number' && Number.isFinite(published) && published > 0
        ? new Date(published * 1000).toISOString().slice(0, 10)
        : undefined;
    const employmentType = formatEmploymentType(stringAt(job, 'employmentType'));

    return {
      title: stringAt(posting, 'title'),
      titleSource: 'posting',
      ...(location ? { location } : {}),
      ...(employmentType ? { employmentType } : {}),
      ...(datePosted ? { datePosted } : {}),
      description,
      strategy: 'board',
    };
  },
};

/**
 * BambooHR. The public URL is `{company}.bamboohr.com/careers/{id}` (the
 * older `…/jobs/view.php?id={id}` redirects there) and the page is a shell —
 * `<div id="poRoot">` and a page of feature flags — whose `og:title` is the
 * only trace of the posting. The page's app loads the opening from
 * `…/careers/{id}/detail`, anonymously, and that is what is read here. The
 * detail names the title, description, location, employment status and
 * posting date; the employer is only in the subdomain, which `metadata.ts`
 * already reads as a board slug.
 *
 * `locationType` is `"1"` for a remote opening — BambooHR's own embeddable
 * job list renders those as "Remote" — and `"2"` for hybrid.
 */
const bambooHr: BoardAdapter = {
  name: 'bamboohr',
  async read(url) {
    if (!/^[a-z0-9-]+\.bamboohr\.com$/i.test(url.hostname)) return null;

    const id =
      /^\/careers\/(\d+)\/?$/i.exec(url.pathname)?.[1] ??
      (/^\/jobs\/view\.php$/i.test(url.pathname) ? url.searchParams.get('id') : null);
    if (!id || !/^\d+$/.test(id)) return null;

    const page = await fetchJobPage(new URL(`/careers/${id}/detail`, url.origin).toString(), { json: true });

    let answer: unknown;
    try {
      answer = JSON.parse(page.html);
    } catch {
      throw new BadGatewayError('BambooHR answered with something that is not JSON.');
    }

    const opening = (answer as { result?: { jobOpening?: unknown } }).result?.jobOpening;
    if (!opening || typeof opening !== 'object') return null;

    const body = stringAt(opening, 'description');
    if (!body || !body.replace(/<[^>]*>/g, '').trim()) return null;

    const compensation = stringAt(opening, 'compensation');
    const description = compensation ? `${body}\n<p><strong>Compensation:</strong> ${compensation}</p>` : body;

    const place = [
      stringAt(opening, 'atsLocation', 'city') ?? stringAt(opening, 'location', 'city'),
      stringAt(opening, 'atsLocation', 'state') ?? stringAt(opening, 'location', 'state'),
      stringAt(opening, 'atsLocation', 'country') ?? stringAt(opening, 'location', 'addressCountry'),
    ]
      .filter(Boolean)
      .join(', ');
    const locationType = stringAt(opening, 'locationType');
    const isRemote = (opening as { isRemote?: unknown }).isRemote === true || locationType === '1';
    const kind = isRemote ? 'Remote' : locationType === '2' ? 'Hybrid' : undefined;
    const location = [kind, place].filter(Boolean).join(', ');

    const employmentType =
      formatEmploymentType(stringAt(opening, 'employmentType')) ?? stringAt(opening, 'employmentStatusLabel');
    const datePosted = /^\d{4}-\d{2}-\d{2}/.exec(stringAt(opening, 'datePosted') ?? '')?.[0];

    return {
      title: stringAt(opening, 'jobOpeningName'),
      titleSource: 'posting',
      ...(location ? { location } : {}),
      ...(employmentType ? { employmentType } : {}),
      ...(datePosted ? { datePosted } : {}),
      description,
      strategy: 'board',
    };
  },
};

const ADAPTERS: BoardAdapter[] = [adpWorkforceNow, gem, bambooHr];

/**
 * The posting via the board's own API, or `null` when the URL belongs to no
 * board we know — or the board's API let us down, in which case the general
 * path gets its turn and the failure is only logged.
 */
export async function readKnownBoard(url: URL): Promise<ExtractedJob | null> {
  for (const adapter of ADAPTERS) {
    try {
      const result = await adapter.read(url);
      if (result) return result;
    } catch (error) {
      logger.warn({ err: error, board: adapter.name, url: url.toString() }, 'board API read failed');
    }
  }
  return null;
}
