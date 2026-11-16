import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUser, request } from './helpers.js';
import { extractJobPosting } from '../src/jobs/extract.js';
import { stripPageFurniture, tidyMarkdown, toMarkdown } from '../src/jobs/markdown.js';
import { isPublicAddress } from '../src/jobs/fetch-page.js';
import {
  boardSlug,
  companyFromMarkdown,
  companyFromSlug,
  parsePageTitle,
  refineMetadata,
  stripCompanyFromTitle,
} from '../src/jobs/metadata.js';
import { env } from '../src/env.js';

/**
 * The route tests below use IP literals so the address check has nothing to
 * resolve. The one exception is the board adapter, which recognises a board
 * by hostname — so every name resolves to a public address here, and the fetch
 * behind it is stubbed like the rest.
 */
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

/**
 * The fetch itself is stubbed: these assert what we do with a page, not that
 * the internet is up. The one thing that must be exercised for real is the
 * address check, because it is the whole of the SSRF defence.
 */

const JSON_LD_PAGE = `
<!doctype html>
<html>
  <head>
    <title>Senior Frontend Engineer at Acme Corp | JobBoard</title>
    <meta property="og:site_name" content="JobBoard" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": "Senior Frontend Engineer",
        "datePosted": "2026-03-01T00:00:00Z",
        "employmentType": "FULL_TIME",
        "hiringOrganization": { "@type": "Organization", "name": "Acme Corp" },
        "jobLocationType": "TELECOMMUTE",
        "jobLocation": {
          "@type": "Place",
          "address": { "addressLocality": "Austin", "addressRegion": "TX" }
        },
        "description": "<h2>About the role</h2><p>We are hiring a <strong>senior</strong> engineer to own our design system and mentor the team through a long overdue rewrite of the component library.</p><ul><li>Five years of React</li><li>TypeScript throughout</li></ul><p>Read our <a href=\\"/handbook\\">handbook</a> before applying, it explains how we work.</p>"
      }
    </script>
  </head>
  <body><nav><a href="/">Home</a></nav><div id="root"></div></body>
</html>
`;

const CONTAINER_PAGE = `
<!doctype html>
<html>
  <head><title>Platform Engineer — Globex</title></head>
  <body>
    <nav><a href="/a">One</a><a href="/b">Two</a><a href="/c">Three</a></nav>
    <div id="jobDescriptionText">
      <h3>What you will do</h3>
      <p>${'Own the deployment pipeline end to end. '.repeat(8)}</p>
      <ul><li>Terraform</li><li>Kubernetes</li></ul>
    </div>
    <footer><a href="/privacy">Privacy</a></footer>
  </body>
</html>
`;

const BARE_PAGE = `
<!doctype html>
<html>
  <head><title>Data Analyst</title></head>
  <body>
    <header><a href="/">Logo</a></header>
    <nav><a href="/jobs">Jobs</a><a href="/companies">Companies</a></nav>
    <div class="wrapper">
      <div class="posting">
        <p>${'We need an analyst who can turn a messy warehouse into a usable one. '.repeat(6)}</p>
        <p>Reporting to the Head of Data.</p>
      </div>
    </div>
    <div class="related"><a href="/1">Job one</a><a href="/2">Job two</a><a href="/3">Job three</a></div>
  </body>
</html>
`;

/**
 * Paylocity: the posting sits in `.job-preview-details`, and its "Apply" is an
 * `<a>` with a button's classes — inside that same block, above the
 * description and again below it. The role and the location are in a sibling
 * block, and "View All Jobs" closes the page.
 */
const LINK_BUTTON_PAGE = `
<!doctype html>
<html>
  <head><title>Commence - Sr. Coding Implementation Engineer</title></head>
  <body>
    <div class="citruslike-container job-preview" role="main">
      <div style="min-height: 50px;">
        <div class="preview-upper-apply-btn"><a class="apply-link-marker button apply-button" href="/Recruiting/Jobs/Apply/1">Apply</a></div>
        <div class="job-preview-header">
          <span class="job-preview-title left"><span>Sr. Coding Implementation Engineer</span></span>
          <div class="preview-location">Fully Remote <span> &bull; </span> Virginia Beach</div>
        </div>
      </div>
      <div class="job-preview-details">
        <div class="mobile-apply-btn"><a class="apply-link-marker button apply-button" href="/Recruiting/Jobs/Apply/1">Apply</a></div>
        <div class="job-listing-header">Description</div>
        <div><p>${'At Commence we build data-centric tooling for health outcomes. '.repeat(6)}</p></div>
        <div class="job-listing-header">Requirements</div>
        <div><ul><li>Advanced SQL</li><li>Hands-on AWS experience</li></ul></div>
        <div class="preview-bottom-apply-btn"><a class="apply-link-marker button apply-button" href="/Recruiting/Jobs/Apply/1">Apply</a></div>
        <div class="vertical-padding"><a href="/Recruiting/Jobs/All/8f95">View All Jobs</a></div>
      </div>
    </div>
    <footer><a href="https://www.paylocity.com/privacy/">Privacy Policy</a></footer>
  </body>
</html>
`;

/**
 * Rippling: the posting is in the page's data under `apiData.jobPost`, whose
 * role is `name` and whose description is an object of sections. The page also
 * ships the UI's own translation store — which holds a short `title` beside a
 * long `description`, the very shape a posting is looked for by, and whose
 * strings still carry their placeholders.
 */
const SPLIT_DESCRIPTION_PAGE = `
<!doctype html>
<html>
  <head><title>Full Stack Software Developer (Remote locations)</title>
    <meta property="og:site_name" content="Rippling Recruiting" /></head>
  <body>
    <div id="__next">Loading…</div>
    <script id="__NEXT_DATA__" type="application/json">
      ${JSON.stringify({
        props: {
          pageProps: {
            _nextI18Next: {
              initialI18nStore: {
                'en-US': {
                  atsFe: {
                    page: {
                      title: '{{companyName}} uses AI to analyze applications',
                      description:
                        '{{companyName}} uses AI technology to review, analyze, and summarize applications. ' +
                        'Please note that all final hiring decisions are made by the hiring team — not by AI. '.repeat(3),
                    },
                  },
                },
              },
            },
            apiData: {
              jobPost: {
                uuid: '00ed7ae5',
                name: 'Full Stack Software Developer (Remote locations)',
                companyName: 'Halborn Inc',
                workLocations: ['Remote, OR'],
                employmentType: { label: 'SALARIED_FT', id: 'Salaried, full-time' },
                createdOn: '2026-09-08T01:44:53.155000-07:00',
                description: {
                  company: `<div><p><b><strong>About Halborn Inc</strong></b></p><p>${'Halborn is an elite cyber security company. '.repeat(6)}</p></div>`,
                  role: `<div><p>${'We are looking for a full stack developer to build our platform. '.repeat(6)}</p><ul><li>Five years of TypeScript</li></ul></div>`,
                },
              },
            },
          },
        },
      })}
    </script>
  </body>
</html>
`;

describe('extractJobPosting', () => {
  it('takes the job out of the page data, not the translation store beside it', () => {
    const extracted = extractJobPosting(SPLIT_DESCRIPTION_PAGE, 'https://ats.rippling.com/halborn/jobs/00ed7ae5');
    const { markdown } = toMarkdown(extracted.description!);

    expect(extracted.strategy).toBe('page-data');
    // The role, from `name` — not the consent notice the UI's own strings are
    // headed with, which is what a "short title beside a long body" used to
    // find first.
    expect(extracted.title).toBe('Full Stack Software Developer (Remote locations)');
    expect(extracted.titleSource).toBe('posting');
    expect(extracted.company).toBe('Halborn Inc');
    expect(extracted.location).toBe('Remote, OR');
    // The readable half of an object that keeps its code under `label`.
    expect(extracted.employmentType).toBe('Salaried, Full-time');
    expect(extracted.datePosted).toBe('2026-09-08');

    // A description split into sections is printed as one, in the order it is
    // written: the company first, then the role.
    expect(markdown).toContain('**About Halborn Inc**');
    expect(markdown.indexOf('elite cyber security')).toBeLessThan(markdown.indexOf('full stack developer'));
    expect(markdown).toContain('- Five years of TypeScript');
    expect(markdown).not.toContain('uses AI');
    expect(markdown).not.toContain('{{');
  });

  it('takes the posting alone from a page whose buttons are links', () => {
    const extracted = extractJobPosting(LINK_BUTTON_PAGE, 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/1');
    const { markdown } = toMarkdown(extracted.description!);

    expect(extracted.strategy).toBe('container');
    expect(markdown).toContain('Advanced SQL');
    expect(markdown).toContain('data-centric tooling');
    // The description and nothing else: not the apply buttons above and below
    // it, not the role and location the block beside it repeats, not the link
    // back to the rest of the board.
    expect(markdown).not.toContain('Apply');
    expect(markdown).not.toContain('Virginia Beach');
    expect(markdown).not.toContain('Sr. Coding Implementation Engineer');
    expect(markdown).not.toContain('View All Jobs');
    expect(markdown).not.toContain('Privacy Policy');
  });

  it('prefers schema.org JobPosting JSON-LD and reads its metadata', () => {
    const result = extractJobPosting(JSON_LD_PAGE, 'https://jobs.example.test/postings/42');

    expect(result.strategy).toBe('json-ld');
    expect(result.title).toBe('Senior Frontend Engineer');
    expect(result.titleSource).toBe('posting');
    expect(result.company).toBe('Acme Corp');
    expect(result.siteName).toBe('JobBoard');
    expect(result.location).toBe('Remote, Austin, TX');
    expect(result.employmentType).toBe('Full Time');
    expect(result.datePosted).toBe('2026-03-01');
    expect(result.description).toContain('About the role');
  });

  it('resolves relative links in the description against the page URL', () => {
    const result = extractJobPosting(JSON_LD_PAGE, 'https://jobs.example.test/postings/42');
    expect(result.description).toContain('https://jobs.example.test/handbook');
  });

  it('falls back to a known container when there is no JSON-LD', () => {
    const result = extractJobPosting(CONTAINER_PAGE, 'https://example.test/job');

    expect(result.strategy).toBe('container');
    expect(result.description).toContain('What you will do');
    expect(result.description).not.toContain('Privacy');
    // The page title is handed over whole; `metadata.ts` takes it apart.
    expect(result.title).toBe('Platform Engineer — Globex');
    expect(result.titleSource).toBe('page');
  });

  it('drops a cookie-consent dialog before choosing a block', () => {
    const consent = `<div id="onetrust-consent-sdk"><h2>Set your cookie preferences</h2><p>${'We use cookies to personalise content and analyse traffic. '.repeat(10)}</p></div>`;
    const result = extractJobPosting(BARE_PAGE.replace('</body>', `${consent}</body>`), 'https://example.test/job');

    expect(result.description).toContain('messy warehouse');
    expect(result.description).not.toContain('cookie');
  });

  it('falls back to the densest block of non-link text', () => {
    const result = extractJobPosting(BARE_PAGE, 'https://example.test/job');

    expect(result.strategy).toBe('readability');
    expect(result.description).toContain('messy warehouse');
    // The related-jobs rail is nearly all anchor text, so it loses on score.
    expect(result.description).not.toContain('Job one');
  });

  it('takes the whole page when no single block is long enough', () => {
    const paragraphs = Array.from({ length: 4 }, (_, i) => `<p>Paragraph ${i} of a short posting written straight under the body.</p>`).join('');
    const result = extractJobPosting(`<html><body><h1>Tester</h1>${paragraphs}</body></html>`, 'https://x.test/');

    expect(result.strategy).toBe('page');
    expect(result.description).toContain('Paragraph 3');
  });

  it('reports no description when the page carries nothing long enough', () => {
    const result = extractJobPosting('<html><body><p>Gone.</p></body></html>', 'https://x.test/');

    expect(result.strategy).toBe('none');
    expect(result.description).toBeUndefined();
  });
});

describe('extractJobPosting with an escaped JSON-LD description', () => {
  it('reads the posting as markup and resolves the links inside it', () => {
    const escaped =
      '&lt;p&gt;We are DeweyLearn, an education technology startup building AI systems that capture expert judgment and turn it into authentic assessment. We&amp;#39;re small and early, and the work is real from day one.&lt;/p&gt;' +
      '&lt;h2 id=&quot;tasks&quot;&gt;Tasks&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Build and maintain production backend services in Python (FastAPI)&lt;/li&gt;&lt;li&gt;Read the &lt;a href=&quot;/handbook&quot;&gt;handbook&lt;/a&gt;&lt;/li&gt;&lt;/ul&gt;';
    const page = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Senior Python Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'DeweyLearn' },
      description: escaped,
    })}</script></head><body></body></html>`;

    const extracted = extractJobPosting(page, 'https://join.com/companies/deweylearnai/16670068-senior-python-engineer');
    expect(extracted.strategy).toBe('json-ld');
    expect(extracted.description).toContain('<h2 id="tasks">Tasks</h2>');
    expect(extracted.description).toContain('href="https://join.com/handbook"');

    const { markdown } = toMarkdown(extracted.description!);
    expect(markdown).toContain('## Tasks');
    expect(markdown).toContain('- Build and maintain production backend services in Python (FastAPI)');
    expect(markdown).toContain("We're small and early");
    expect(markdown).not.toContain('&lt;');
    expect(markdown).not.toContain('<p>');
  });
});

describe('extractJobPosting from the page\'s own data', () => {
  /** A company site on Next.js: the DOM says "Loading…", `__NEXT_DATA__` carries the Greenhouse job. */
  const NEXT_PAGE = (jobData: unknown) => `<!doctype html><html><head>
    <title>Job Posting</title>
    <meta property="og:title" content="Software Engineer, AI Automation, Any location, United States | Coalition, Inc."/>
    <meta name="description" content="Take a look at the jobs that we have currently open, here at Coalition Inc!"/>
    </head><body>
    <nav><a href="/insurance">Insurance</a><a href="/security">Security</a></nav>
    <main id="main-content"><h2>Viewing Our Current Openings</h2><h3>Loading...</h3><a href="/careers">Back to Careers</a></main>
    <footer>Copyright © 2026. All rights reserved.</footer>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { pageData: { pageV2: { title: 'Job Posting', header: { navigationItems: [{ title: 'Insurance' }] } } }, jobData } },
      page: '/job-posting/[id]',
    })}</script>
    </body></html>`;

  const JOB = {
    absolute_url: 'https://www.coalitioninc.com/job-posting?gh_jid=4731293005',
    location: { name: 'Any location, United States' },
    id: 4731293005,
    updated_at: '2026-09-04T18:36:20-04:00',
    title: 'Software Engineer, AI Automation',
    content:
      '&lt;div class=&quot;content-intro&quot;&gt;&lt;h4&gt;About us&lt;/h4&gt;&lt;p&gt;Coalition is the world&amp;#39;s first Active Insurance provider designed to prevent digital risk before it strikes.&lt;/p&gt;&lt;/div&gt;' +
      '&lt;h3&gt;The role&lt;/h3&gt;&lt;p&gt;You will build the automation that lets our teams do more with AI, from internal tools to customer-facing systems, and own it in production.&lt;/p&gt;' +
      '&lt;ul&gt;&lt;li&gt;Ship production Python and TypeScript&lt;/li&gt;&lt;li&gt;Read the &lt;a href=&quot;/handbook&quot;&gt;handbook&lt;/a&gt;&lt;/li&gt;&lt;/ul&gt;',
    departments: [{ id: 1, name: 'Engineering' }],
    offices: [{ id: 2, name: 'United States - Remote' }],
  };

  it('reads the posting the browser would have rendered, not the shell around it', () => {
    const extracted = extractJobPosting(NEXT_PAGE(JOB), 'https://www.coalitioninc.com/job-posting/4731293005');

    expect(extracted.strategy).toBe('page-data');
    expect(extracted.title).toBe('Software Engineer, AI Automation');
    expect(extracted.titleSource).toBe('posting');
    expect(extracted.location).toBe('Any location, United States');
    expect(extracted.description).toContain('<h3>The role</h3>');
    expect(extracted.description).toContain('href="https://www.coalitioninc.com/handbook"');
    expect(extracted.description).not.toContain('Viewing Our Current Openings');

    const { markdown } = toMarkdown(extracted.description!);
    expect(markdown).toContain('### The role');
    expect(markdown).toContain('- Ship production Python and TypeScript');
    expect(markdown).toContain("world's first");
    expect(markdown).not.toContain('Back to Careers');
  });

  it('names the employer from the page title, not the shell, and keeps "Coalition, Inc." from being a place', () => {
    const extracted = extractJobPosting(NEXT_PAGE(JOB), 'https://www.coalitioninc.com/job-posting/4731293005');
    const { markdown } = toMarkdown(extracted.description!);
    const result = refineMetadata({
      titles: [extracted.title, extracted.pageTitle],
      structured: true,
      company: extracted.company,
      siteName: extracted.siteName,
      markdown,
      url: 'https://www.coalitioninc.com/job-posting/4731293005',
    });
    // og:title is not among the titles the service hands over first for a
    // structured read, but the page title is; here the company has to come
    // from the description or the og:title. Both name Coalition.
    expect(result.title).toBe('Software Engineer, AI Automation');
    expect(result.company).toMatch(/^Coalition/);
  });

  it('reads bold nested in bold as bold, not as four asterisks', () => {
    const { markdown } = toMarkdown('<p><b><strong>About us</strong></b></p><p>We build things.</p>');
    expect(markdown).toContain('**About us**');
    expect(markdown).not.toContain('****');
  });

  it('is not fooled by data that merely has a title', () => {
    const page = NEXT_PAGE({ title: 'Job Posting', content: 'Loading' });
    const extracted = extractJobPosting(page, 'https://www.coalitioninc.com/job-posting/1');
    expect(extracted.strategy).not.toBe('page-data');
  });
});

describe('toMarkdown', () => {
  it('converts posting markup to Markdown', () => {
    const { markdown, truncated } = toMarkdown(
      '<h2>About</h2><p>We want a <strong>senior</strong> engineer.</p><ul><li>React</li><li>TypeScript</li></ul>',
    );

    expect(markdown).toBe(
      ['## About', '', 'We want a **senior** engineer.', '', '- React', '- TypeScript'].join('\n'),
    );
    expect(truncated).toBe(false);
  });

  it('drops images and keeps links', () => {
    const { markdown } = toMarkdown(
      '<p><img src="https://x.test/pixel.gif" /> See the <a href="https://x.test/h">handbook</a>.</p>',
    );

    expect(markdown).not.toContain('pixel.gif');
    expect(markdown).toContain('[handbook](https://x.test/h)');
  });

  it('keeps the paragraphs of a plain-text description', () => {
    const { markdown } = toMarkdown('About the role\n\nWhat you will do\n- Ship things');

    expect(markdown).toContain('About the role');
    expect(markdown).toContain('- Ship things');
  });

  it('decodes markup that arrived entity-escaped, as JOIN publishes it', () => {
    const { markdown } = toMarkdown(
      '&lt;p&gt;We are DeweyLearn. We&amp;#39;re small and early.&lt;/p&gt;\n' +
        '&lt;h2 id=&quot;tasks&quot;&gt;Tasks&lt;/h2&gt;\n&lt;ul&gt;\n&lt;li&gt;Build APIs in Python&lt;/li&gt;\n&lt;/ul&gt;',
    );

    expect(markdown).toBe(
      ["We are DeweyLearn. We're small and early.", '', '## Tasks', '', '- Build APIs in Python'].join('\n'),
    );
  });

  it('decodes markup escaped twice, and leaves a description about HTML alone', () => {
    expect(toMarkdown('&amp;lt;p&amp;gt;Twice over&amp;lt;/p&amp;gt;').markdown).toBe('Twice over');

    const about = toMarkdown('<p>You will write <code>&lt;section&gt;</code> and <code>&lt;article&gt;</code> tags.</p>');
    expect(about.markdown).toBe('You will write `<section>` and `<article>` tags.');
  });

  it('turns typographic bullets into list items', () => {
    const { markdown } = toMarkdown('<p>Requirements</p><p>• React<br />• TypeScript</p>');

    expect(markdown).toMatch(/^- React$/m);
  });

  it('truncates a posting longer than the cap and says so', () => {
    const long = `<p>${'A very long paragraph about the role. '.repeat(1200)}</p>`;
    const { markdown, truncated } = toMarkdown(long);

    expect(truncated).toBe(true);
    expect(markdown.length).toBeLessThan(21_000);
    expect(markdown).toContain('truncated');
  });
});

describe('parsePageTitle', () => {
  it.each([
    ['Senior Frontend Engineer at Acme Corp | JobBoard', 'Senior Frontend Engineer', 'Acme Corp'],
    ['Job Application for Senior Engineer at Acme', 'Senior Engineer', 'Acme'],
    ['Acme hiring Senior Engineer in Austin, TX | LinkedIn', 'Senior Engineer', 'Acme'],
    ['Senior Software Engineer, Cloud Platform @ Temporal Technologies', 'Senior Software Engineer, Cloud Platform', 'Temporal Technologies'],
    ['Engineer at scale at Acme', 'Engineer at scale', 'Acme'],
  ])('takes %s apart', (title, role, company) => {
    expect(parsePageTitle(title)).toEqual({ role, company });
  });

  // Which side of a separator is the company is a guess, so the whole title
  // stays the role: it is the answer whenever the guess loses to a company
  // named outright somewhere else, and `stripCompanyFromTitle` takes the name
  // back out when the guess wins.
  it.each([
    ['Acme - Senior Engineer', 'Acme - Senior Engineer', 'Acme'],
    ['Platform Engineer — Globex', 'Platform Engineer — Globex', 'Globex'],
    ['Careers | Acme | Senior Data Scientist', 'Acme | Senior Data Scientist', 'Acme'],
    ['Product Designer | Remote | Stripe', 'Product Designer | Stripe', 'Stripe'],
  ])('marks the company it guesses at in %s as weak', (title, role, company) => {
    expect(parsePageTitle(title)).toEqual({ role, company, weakCompany: true });
  });

  it('does not take a role qualifier after a hyphen for a company', () => {
    // job-boards.greenhouse.io/newrelic/jobs/5416517008: the employer is in
    // the document title, and "Auth0/AuthZ (Java)" is part of the role.
    expect(parsePageTitle('Software Engineer - Auth0/AuthZ (Java)')).toEqual({
      role: 'Software Engineer - Auth0/AuthZ (Java)',
    });
    expect(parsePageTitle('Job Application for Software Engineer - Auth0/AuthZ (Java) at New Relic')).toEqual({
      role: 'Software Engineer - Auth0/AuthZ (Java)',
      company: 'New Relic',
    });
  });

  it('drops a location and the board from an Indeed-style title', () => {
    expect(parsePageTitle('Senior Engineer - Austin, TX 78701 - Indeed.com')).toEqual({ role: 'Senior Engineer' });
  });

  it('leaves a hyphenated role alone', () => {
    expect(parsePageTitle('Controls SME - Design')).toEqual({ role: 'Controls SME - Design' });
  });

  it('treats a JavaScript shell\'s title as no title', () => {
    expect(parsePageTitle('Recruitment')).toEqual({});
    expect(parsePageTitle('Career Center | Recruitment')).toEqual({});
  });

  it('does not take a board that names itself in the title for the employer', () => {
    // A Dayforce portal titles every page "<role> | Dayforce Jobs", and the
    // employer is in the posting: "Aline is the bridge between…".
    expect(
      refineMetadata({
        titles: ['Engineering - Software Engineer (AI & Agentic Solutions) | Dayforce Jobs'],
        structured: false,
        markdown: 'Aline is the bridge between senior care and technology, built to strengthen connection.',
        url: 'https://jobs.dayforcehcm.com/en-US/aline/candidateportal/jobs/1197',
      }),
    ).toEqual({ title: 'Engineering - Software Engineer (AI & Agentic Solutions)', company: 'Aline' });
  });

  it('reads a careers-site title as the company alone', () => {
    expect(parsePageTitle('Rendered Inc Careers')).toEqual({ company: 'Rendered Inc' });
  });
});

describe('parsePageTitle and legal suffixes', () => {
  it('does not take "Coalition, Inc." for a place', () => {
    expect(parsePageTitle('Software Engineer, AI Automation, Any location, United States | Coalition, Inc.')).toEqual({
      role: 'Software Engineer, AI Automation, Any location, United States | Coalition, Inc.',
      company: 'Coalition, Inc.',
      weakCompany: true,
    });
    expect(parsePageTitle('Senior Engineer at Acme, Ltd.')).toEqual({ role: 'Senior Engineer', company: 'Acme, Ltd.' });
    // A real place is still a place.
    expect(parsePageTitle('Senior Engineer | Austin, TX')).toEqual({ role: 'Senior Engineer' });
  });
});

describe('stripCompanyFromTitle', () => {
  it.each([
    ['Senior Engineer at Acme Corp', 'Acme Corp'],
    ['Senior Engineer - Acme Corp', 'Acme Corp'],
    ['Senior Engineer | Acme', 'Acme Corp Inc.'],
    ['Senior Engineer (Acme)', 'Acme'],
    ['Acme: Senior Engineer', 'Acme'],
    ['Acme - Senior Engineer', 'ACME'],
  ])('turns %s into the role', (title, company) => {
    expect(stripCompanyFromTitle(title, company)).toBe('Senior Engineer');
  });

  it('does nothing when the company is not there', () => {
    expect(stripCompanyFromTitle('Senior Engineer - Design', 'Acme')).toBe('Senior Engineer - Design');
  });
});

describe('companyFromMarkdown', () => {
  it('reads an "About" heading, bold or not', () => {
    expect(companyFromMarkdown('**About Applied Digital:**\n\nWe build data centres.')).toBe('Applied Digital');
    expect(companyFromMarkdown('## About the role\n\nStuff.\n\n## About Globex Corporation\n\nMore.')).toBe('Globex Corporation');
  });

  it('reads "At X, we" and "X is hiring"', () => {
    expect(companyFromMarkdown('Intro.\n\nAt Initech, we build things.')).toBe('Initech');
    expect(companyFromMarkdown('Join Our Talent Community\n\nHooli is hiring a Senior Engineer.')).toBe('Hooli');
  });

  it('reads an employer introducing itself at the top of the posting', () => {
    expect(companyFromMarkdown('CentralReach is a leading provider of autism care software.\n\nMore.')).toBe('CentralReach');
  });

  it('answers nothing rather than a phrase', () => {
    expect(companyFromMarkdown('## About the team\n\nWe are great.\n\nJoin our team as an engineer.')).toBeUndefined();
    expect(companyFromMarkdown('Requirements:\n\n- Terraform is a plus\n\nKubernetes is a must.')).toBeUndefined();
  });
});

describe("a board's own name in og:site_name", () => {
  it('is not taken for the employer when it is a board name with a site word after it', () => {
    // Rippling: og:site_name "Rippling Recruiting", og:title "Role | Company".
    const result = refineMetadata({
      titles: ['Senior Software Engineer | Moov'],
      structured: false,
      siteName: 'Rippling Recruiting',
      markdown: '## Senior Software Engineer\n\nAt Moov, we’re empowering creators to embed fintech everywhere.',
      url: 'https://ats.rippling.com/moov/jobs/d4ea384f-e664-47ff-a164-e797012a8f2e',
    });
    expect(result).toEqual({ title: 'Senior Software Engineer', company: 'Moov' });

    for (const name of ['Greenhouse Job Board', 'Lever Careers', 'Powered by Workable', 'BambooHR ATS']) {
      expect(
        refineMetadata({ titles: ['Platform Engineer'], structured: false, siteName: name, markdown: '', url: 'https://careers.example.com/1' }),
      ).toEqual({ title: 'Platform Engineer' });
    }
  });

  it('is the last resort on a hosted board, where an unknown site name is the board\'s more often than not', () => {
    // The board slug and the posting both name Moov; the site name does not win.
    expect(
      refineMetadata({
        titles: ['Senior Software Engineer'],
        structured: false,
        siteName: 'Some ATS Vendor',
        markdown: 'At Moov, we build payments.',
        url: 'https://ats.rippling.com/moov/jobs/1',
      }),
    ).toEqual({ title: 'Senior Software Engineer', company: 'Moov' });

    // Nothing else names the employer: the site name is still better than nothing.
    expect(
      refineMetadata({
        titles: ['Senior Software Engineer'],
        structured: false,
        siteName: 'Acme Talent Hub',
        markdown: 'We build payments.',
        url: 'https://www.linkedin.com/jobs/view/1',
      }),
    ).toEqual({ title: 'Senior Software Engineer', company: 'Acme Talent Hub' });
  });

  it('still names the employer on a company-run careers site', () => {
    expect(
      refineMetadata({
        titles: ['Senior Software Engineer'],
        structured: false,
        siteName: 'Newsmatics',
        markdown: 'We build news tech.',
        url: 'https://careers.newsmatics.com/jobs/1',
      }),
    ).toEqual({ title: 'Senior Software Engineer', company: 'Newsmatics' });
  });
});

describe('boardSlug and companyFromSlug', () => {
  it.each([
    ['https://ats.rippling.com/moov/jobs/d4ea384f-e664-47ff-a164-e797012a8f2e', 'moov'],
    ['https://job-boards.greenhouse.io/centralreach/jobs/4396809009', 'centralreach'],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/1', 'acme'],
    ['https://jobs.gem.com/chiri/am9icG9zdDqtkK2RuSE24okIC3uOdbVI', 'chiri'],
    ['https://jobs.lever.co/acme/uuid', 'acme'],
    ['https://jobs.ashbyhq.com/temporal/x', 'temporal'],
    ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/x', 'acme'],
    ['https://jobs.smartrecruiters.com/CentralReach1/123', 'CentralReach1'],
    // Dayforce puts the locale first, so the employer is the second segment.
    ['https://jobs.dayforcehcm.com/en-US/aline/candidateportal/jobs/1197', 'aline'],
    ['https://jobs.dayforcehcm.com/aline/candidateportal/jobs/1197', 'aline'],
  ])('finds the employer segment in %s', (url, slug) => {
    expect(boardSlug(url)).toBe(slug);
  });

  it('finds nothing in a URL that is not a hosted board', () => {
    expect(boardSlug('https://www.linkedin.com/jobs/view/1')).toBeUndefined();
    expect(boardSlug('https://careers.acme.com/jobs/1')).toBeUndefined();
  });

  it('takes the spelling from the page when the slug appears in it', () => {
    expect(companyFromSlug('centralreach', 'Sr. Engineer at CentralReach')).toBe('CentralReach');
    expect(companyFromSlug('applied-digital', 'At Applied Digital, we build.')).toBe('Applied Digital');
    expect(companyFromSlug('applied-digital', 'At AppliedDigital we build.')).toBe('AppliedDigital');
  });

  it('title-cases a slug the page never spells out', () => {
    expect(companyFromSlug('applied-digital', 'nothing')).toBe('Applied Digital');
    expect(companyFromSlug('CentralReach1', 'nothing')).toBe('CentralReach');
  });
});

describe('refineMetadata', () => {
  it('keeps a structured title whole apart from a trailing company', () => {
    expect(refineMetadata({ titles: ['Controls SME - Design'], structured: true, markdown: '' })).toEqual({
      title: 'Controls SME - Design',
    });
    expect(
      refineMetadata({ titles: ['Senior Engineer at Acme'], structured: true, company: 'Acme Corp Inc.', markdown: '' }),
    ).toEqual({ title: 'Senior Engineer', company: 'Acme Corp Inc.' });
  });

  it('does not take the board for the employer', () => {
    const result = refineMetadata({
      titles: ['Senior Engineer'],
      structured: true,
      siteName: 'Greenhouse',
      markdown: '## About Globex\n\nGlobex makes things.',
    });
    expect(result).toEqual({ title: 'Senior Engineer', company: 'Globex' });
  });

  it('reads the company from the document title when og:title has only the role', () => {
    const result = refineMetadata({
      titles: ['Sr. Software Engineer, Ruby on Rails', 'Job Application for Sr. Software Engineer, Ruby on Rails at CentralReach'],
      structured: false,
      markdown: '',
    });
    expect(result).toEqual({ title: 'Sr. Software Engineer, Ruby on Rails', company: 'CentralReach' });
  });

  it('falls back to the board URL for the company', () => {
    const result = refineMetadata({
      titles: ['Sr. Software Engineer'],
      structured: false,
      markdown: 'Nothing about the employer here.',
      url: 'https://job-boards.greenhouse.io/central-reach/jobs/1',
    });
    expect(result).toEqual({ title: 'Sr. Software Engineer', company: 'Central Reach' });
  });

  it('takes the employer from the document title, not from the hyphen in the role', () => {
    // job-boards.greenhouse.io/newrelic/jobs/5416517008. og:title is
    // "Software Engineer - Auth0/AuthZ (Java)", which reads like
    // "Role - Company" and is not; the document title names New Relic.
    const result = refineMetadata({
      titles: [
        'Software Engineer - Auth0/AuthZ (Java)',
        'Job Application for Software Engineer - Auth0/AuthZ (Java) at New Relic',
      ],
      structured: false,
      markdown: '## Software Engineer - Auth0/AuthZ (Java)\n\nJoin the identity team.',
      url: 'https://job-boards.greenhouse.io/newrelic/jobs/5416517008',
    });
    expect(result).toEqual({ title: 'Software Engineer - Auth0/AuthZ (Java)', company: 'New Relic' });
  });

  it('prefers the posting and the board URL to a company guessed from a separator', () => {
    // "Data Platform" is the team, not the employer.
    expect(
      refineMetadata({
        titles: ['Staff Engineer - Data Platform'],
        structured: false,
        markdown: '**About Applied Digital:**\n\nWe build data centres.',
        url: 'https://boards.greenhouse.io/applied-digital/jobs/1',
      }),
    ).toEqual({ title: 'Staff Engineer - Data Platform', company: 'Applied Digital' });

    // With nothing else naming an employer, the guess is still better than a
    // blank field — and the title loses the name once it is used as one.
    expect(
      refineMetadata({
        titles: ['Product Designer | Remote | Stripe'],
        structured: false,
        markdown: 'We design payments.',
      }),
    ).toEqual({ title: 'Product Designer', company: 'Stripe' });
  });

  it('ranks a shell page title below the first heading of the posting', () => {
    const result = refineMetadata({
      titles: ['Career Center | Recruitment', 'Recruitment'],
      structured: false,
      markdown: '## Controls SME - Design\n\n**About Applied Digital:**\n\nAt Applied Digital, we build.',
    });
    expect(result).toEqual({ title: 'Controls SME - Design', company: 'Applied Digital' });
  });
});

describe('stripPageFurniture', () => {
  const posting = 'Rendered Inc is hiring a staff engineer to lead the platform team. '.repeat(6);

  it('reads a button written as a link as the word it shows', () => {
    const page = [
      '[Apply](https://recruiting.example.test/Recruiting/Jobs/Apply/1)',
      posting,
      '[View All Jobs](https://recruiting.example.test/Recruiting/Jobs/All/8f95)',
    ].join('\n\n');

    expect(stripPageFurniture(page)).toBe(posting.trim());
  });

  it('leaves a link inside the posting alone', () => {
    const page = `${posting}\n\nRead our [handbook](https://example.test/handbook) before applying.`;
    expect(stripPageFurniture(page)).toContain('[handbook](https://example.test/handbook)');
  });

  it('removes a portal\'s navigation, its language picker and its footer repeat', () => {
    // A Dayforce candidate portal: a nav rail written as a list of links, the
    // language it is being read in, the job's locations under the title — and
    // the same locations again in the footer, punctuated differently.
    const page = [
      '[Skip to Content](https://jobs.example.test/en-US/aline/candidateportal/jobs/1#main-content)',
      '*   [![Image 1: Logo](https://jobs.example.test/logo.png)](https://jobs.example.test/en-US/aline)\n' +
        '*   [Search Jobs](https://jobs.example.test/en-US/aline/candidateportal)\n' +
        '*   [Recommended Jobs](https://jobs.example.test/en-US/aline/candidateportal/recommendedJobs)',
      'English (United States)',
      '[Sign In](https://jobs.example.test/en-US/aline/candidateportal/jobs/1#)',
      '# Software Engineer (AI & Agentic Solutions)',
      'Virtual•',
      'Georgia, USA•',
      '## Job Description',
      posting,
      'Virtual,',
      'Georgia, USA,',
      'Scan this QR code and apply!',
      '[Download](https://jobs.example.test/en-US/aline/candidateportal/jobs/1#)',
      '©2009-2026 Dayforce HCM, Inc. All Rights Reserved.',
    ].join('\n\n');

    // Through `tidyMarkdown`, which is the path the reader's answer takes:
    // the logo is dropped as an image before the nav rail is judged a list of
    // links and nothing else.
    const { markdown: result } = tidyMarkdown(page);

    expect(result).toContain('# Software Engineer (AI & Agentic Solutions)');
    expect(result).toContain('## Job Description');
    expect(result).toContain(posting.trim());
    // The job's own locations, once — under the title, where the posting puts
    // them, and not again in the footer.
    expect(result.match(/Virtual/g)).toHaveLength(1);
    expect(result.match(/Georgia, USA/g)).toHaveLength(1);
    for (const noise of ['Skip to Content', 'Search Jobs', 'Recommended Jobs', 'English (United States)', 'Sign In', 'QR code', 'Download', 'All Rights Reserved']) {
      expect(result, noise).not.toContain(noise);
    }
  });

  it('removes the account strip a portal puts above a posting, and its footer below', () => {
    const page = [
      'Careers',
      'Sign In',
      'Create Account',
      '# Senior Python Engineer',
      posting,
      '[Terms of Use |](http://paycom.com/terms-of-use.php)[Privacy Policy |](http://paycom.com/privacy.php) © 2026 Paycom | All Rights Reserved.',
      'X',
    ].join('\n\n');

    const result = stripPageFurniture(page);
    expect(result).toContain('# Senior Python Engineer');
    expect(result).toContain(posting.trim());
    for (const noise of ['Careers', 'Sign In', 'Create Account', 'Terms of Use', 'All Rights Reserved']) {
      expect(result).not.toContain(noise);
    }
  });

  it('removes share rows, apply buttons and the cookie dialog around a posting', () => {
    const page = [
      'Join Our Talent Community',
      'Facebook LinkedIn Email X Copy URL',
      'If you are unable to complete this application due to a disability, contact this employer.',
      '## Controls SME - Design',
      'Apply',
      posting,
      '- Ten years of experience\n- Kubernetes',
      'Back Apply',
      'Copyright © 2026, ADP, Inc. All rights reserved.',
      'Powered by',
      'Privacy|Legal|Requirements|Artificial Intelligence',
      'We use our own and third-party cookies and similar technologies to enhance your experience.',
      '## Set your cookie preferences',
      'ADP values your privacy. Please choose whether this site may use Functional, Analytics and/or Advertising cookies.',
      '#### Functional',
      '- [x] Functional',
      'These cookies are used to enable enhanced functionality.',
    ].join('\n\n');

    const result = stripPageFurniture(page);
    expect(result).toContain('## Controls SME - Design');
    expect(result).toContain('- Kubernetes');
    expect(result).toContain(posting.trim());
    for (const noise of ['Talent Community', 'Facebook', 'disability', 'Apply', 'Copyright', 'Powered by', 'Privacy|', 'cookie', 'Functional']) {
      expect(result).not.toContain(noise);
    }
  });

  it('keeps a cookie notice that precedes the posting from cutting it off', () => {
    const page = ['We use cookies to make the site work.', '# Staff Engineer', posting].join('\n\n');
    const result = stripPageFurniture(page);
    expect(result).toContain('# Staff Engineer');
    expect(result).toContain('platform team');
    expect(result).not.toContain('cookies');
  });

  it('drops a linked logo without leaving an empty link behind', () => {
    const { markdown } = tidyMarkdown(`[![Image 1: Company Logo](blob:http://localhost/abc)](https://x.test/)\n\n${posting}`);
    expect(markdown).not.toContain('[](');
    expect(markdown).not.toContain('blob:');
    expect(markdown.startsWith('Rendered Inc')).toBe(true);
  });
});

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.5',
    '172.16.4.4',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    'not-an-ip',
  ])('rejects %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '203.0.114.1', '2606:2800:220:1::1'])(
    'accepts %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('POST /api/jobs/parse', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A stub standing in for the site being fetched, and for the reader service
   * the parser falls back to. The URLs in these cases are IP literals so the
   * address check has nothing to resolve — the DNS path is covered by
   * `isPublicAddress` above.
   *
   * A fresh `Response` per call: the parser reads the site and then, on a
   * miss, asks the reader, and a body can only be read once. Unless a case
   * says otherwise the reader answers 404, so what is being tested is the
   * direct read alone.
   */
  function stubFetch(
    body: string,
    init: { status?: number; contentType?: string } = {},
    reader: { body: string; status?: number; contentType?: string } = { body: '', status: 404 },
  ) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(url);
        if (url.startsWith(env.JOB_READER_URL)) {
          return new Response(reader.body, {
            status: reader.status ?? 200,
            headers: { 'content-type': reader.contentType ?? 'application/json' },
          });
        }
        return new Response(body, {
          status: init.status ?? 200,
          headers: { 'content-type': init.contentType ?? 'text/html; charset=utf-8' },
        });
      }),
    );
    return calls;
  }

  const READER_ANSWER = JSON.stringify({
    code: 200,
    data: {
      title: 'Staff Engineer at Rendered Inc',
      url: 'https://93.184.216.34/rendered',
      content:
        '# Staff Engineer\n\n![logo](https://93.184.216.34/logo.png)\n\n' +
        'Rendered Inc is hiring a staff engineer to lead the platform team. '.repeat(6) +
        '\n\n- Ten years of experience\n- Kubernetes',
    },
  });

  it('requires authentication', async () => {
    await request().post('/api/jobs/parse').send({ url: 'https://example.com/job' }).expect(401);
  });

  it('rejects a value that is not a URL', async () => {
    const user = await createUser();
    const response = await user.agent.post('/api/jobs/parse').send({ url: 'not a url' }).expect(400);

    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('refuses a URL that resolves to a private address, without asking the reader', async () => {
    const user = await createUser();
    const calls = stubFetch('', {}, { body: READER_ANSWER });
    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'http://127.0.0.1:5432/' })
      .expect(422);

    expect(response.body.error.message).toMatch(/private network/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses a non-http scheme', async () => {
    const user = await createUser();
    // `z.url()` accepts any scheme, so the guard rather than the schema is what
    // has to reject this.
    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'file:///etc/passwd' })
      .expect(422);

    expect(response.body.error.message).toMatch(/http/i);
  });

  it('returns the posting as Markdown', async () => {
    const user = await createUser();
    stubFetch(JSON_LD_PAGE);

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/postings/42' })
      .expect(200);

    expect(response.body).toMatchObject({
      title: 'Senior Frontend Engineer',
      company: 'Acme', // stored without the legal form: "Acme Corp" on the page
      location: 'Remote, Austin, TX',
      strategy: 'json-ld',
      truncated: false,
    });
    expect(response.body.description).toContain('## About the role');
    expect(response.body.description).toContain('**senior**');
  });

  it('reports a page with no description as unprocessable when the reader has none either', async () => {
    const user = await createUser();
    const calls = stubFetch('<html><body><p>Nothing here.</p></body></html>');

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/gone' })
      .expect(422);

    expect(response.body.error.message).toMatch(/no job description/i);
    // Both reads were tried before giving up.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(`${env.JOB_READER_URL}https://93.184.216.34/gone`);
  });

  it('falls back to the reader service when the page holds no posting', async () => {
    const user = await createUser();
    stubFetch(
      '<html><head><title>Rendered Inc Careers</title></head><body><div id="app"></div></body></html>',
      {},
      { body: READER_ANSWER },
    );

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/rendered' })
      .expect(200);

    expect(response.body.strategy).toBe('reader');
    expect(response.body.description).toContain('# Staff Engineer');
    expect(response.body.description).toContain('- Kubernetes');
    expect(response.body.description).not.toContain('logo.png');
    // The shell's own title is the careers site's name, which is the company,
    // not the role; the reader's title carries both.
    expect(response.body.title).toBe('Staff Engineer');
    expect(response.body.company).toBe('Rendered') // "Rendered Inc" on the page, stored without the legal form;
  });

  it('asks the reader again, waiting for the page, when it answers with a shell', async () => {
    // Paycom's portal: the page is "Loading…" and a line asking for
    // JavaScript until the app has fetched the posting, and a reader that
    // answers before then answers with nothing worth having.
    const seen: { url: string; headers: Headers }[] = [];
    const shell = JSON.stringify({ data: { title: 'Loading...', content: 'You need to enable JavaScript to run this app.' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        seen.push({ url, headers: new Headers(init?.headers) });
        if (!url.startsWith(env.JOB_READER_URL)) {
          return new Response('<html><body><div id="root">Loading…</div></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        const rendered = seen.filter((call) => call.url.startsWith(env.JOB_READER_URL)).length > 1;
        return new Response(rendered ? READER_ANSWER : shell, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const user = await createUser();
    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/spa' })
      .expect(200);

    expect(response.body.strategy).toBe('reader');
    expect(response.body.description).toContain('Rendered Inc is hiring');

    const readerCalls = seen.filter((call) => call.url.startsWith(env.JOB_READER_URL));
    expect(readerCalls).toHaveLength(2);
    // The plain read first — waiting costs time, and nearly every page is
    // finished when the reader looks at it.
    expect(readerCalls[0]!.headers.get('x-wait-for-selector')).toBeNull();
    // Then the same URL again, waiting for the posting's own heading.
    expect(readerCalls[1]!.headers.get('x-wait-for-selector')).toBe('h1');
    expect(readerCalls[1]!.headers.get('x-timeout')).toBe('20');
  });

  it('asks only once when the reader fails outright, rather than failing twice', async () => {
    const calls = stubFetch('<html><body><div id="root">Loading…</div></body></html>', {}, { body: '', status: 503 });

    const user = await createUser();
    await user.agent.post('/api/jobs/parse').send({ url: 'https://93.184.216.34/spa' }).expect(422);

    expect(calls.filter((url) => url.startsWith(env.JOB_READER_URL))).toHaveLength(1);
  });

  it('falls back to the reader service when the site refuses', async () => {
    const user = await createUser();
    stubFetch('<html>Forbidden</html>', { status: 403 }, { body: READER_ANSWER });

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/private' })
      .expect(200);

    expect(response.body.strategy).toBe('reader');
    expect(response.body.title).toBe('Staff Engineer');
    expect(response.body.company).toBe('Rendered');
  });

  it('reads the company from the document title when og:title is the role alone', async () => {
    const user = await createUser();
    stubFetch(
      CONTAINER_PAGE.replace(
        '<title>Platform Engineer — Globex</title>',
        '<title>Job Application for Platform Engineer at Globex</title><meta property="og:title" content="Platform Engineer" />',
      ),
    );

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/globex/jobs/1' })
      .expect(200);

    expect(response.body).toMatchObject({ strategy: 'container', title: 'Platform Engineer', company: 'Globex' });
  });

  it('splits a page title into role and company when there is no JSON-LD', async () => {
    const user = await createUser();
    stubFetch(CONTAINER_PAGE.replace('<title>Platform Engineer — Globex</title>', '<title>Job Application for Platform Engineer at Globex | Greenhouse</title>'));

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/globex/jobs/1' })
      .expect(200);

    expect(response.body).toMatchObject({ strategy: 'container', title: 'Platform Engineer', company: 'Globex' });
  });

  const ADP_URL =
    'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=4e1f673a-e23b-4f79-98bf-9967bc802aac&ccId=19000101_000003&jobId=567022&lang=en_US';

  const ADP_REQUISITION = JSON.stringify({
    itemID: '9201847180440_1',
    requisitionTitle: 'Controls SME - Design',
    postDate: '2026-09-04T18:29:00.000-04:00',
    clientRequisitionID: '1156',
    requisitionDescription:
      "<div><p><strong>About Applied Digital:</strong></p><p>At Applied Digital, we are the epicenter of AI innovation, crafting data center solutions for high-performance computing. " +
      'We are a team of resilient, forward-thinking innovators driving the AI revolution.</p><p><strong>Key Responsibilities:</strong></p><ul><li>System design</li><li>Compliance</li></ul></div>',
    requisitionLocations: [
      { address: { cityName: 'Dallas', countrySubdivisionLevel1: { codeValue: 'TX' } }, nameCode: { shortName: '100% REMOTE POSITION, Dallas, TX, US' } },
    ],
  });

  /** ADP's shell page, and its requisition API answering beside it. */
  function stubAdp(api: { body: string; status?: number; contentType?: string }) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(url);
        if (url.includes('/careercenter/public/events/staffing/v1/job-requisitions/')) {
          return new Response(api.body, {
            status: api.status ?? 200,
            headers: { 'content-type': api.contentType ?? 'application/json' },
          });
        }
        if (url.startsWith(env.JOB_READER_URL)) return new Response('', { status: 404 });
        return new Response('<html><head><title>Recruitment</title></head><body><div id="app"></div></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }),
    );
    return calls;
  }

  it('reads an ADP WorkforceNow posting through the board\'s own API', async () => {
    const user = await createUser();
    const calls = stubAdp({ body: ADP_REQUISITION });

    const response = await user.agent.post('/api/jobs/parse').send({ url: ADP_URL }).expect(200);

    expect(response.body).toMatchObject({
      strategy: 'board',
      title: 'Controls SME - Design',
      company: 'Applied Digital',
      location: '100% REMOTE POSITION, Dallas, TX, US',
      datePosted: '2026-09-04',
    });
    expect(response.body.description).toContain('**About Applied Digital:**');
    expect(response.body.description).toContain('- Compliance');
    // The shell page was never fetched, and neither was the reader asked.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/job-requisitions/567022?cid=4e1f673a-e23b-4f79-98bf-9967bc802aac&ccId=19000101_000003&lang=en_US');
  });

  it('falls through to the general path when the board API fails', async () => {
    const user = await createUser();
    const calls = stubAdp({ body: '{"error":"gone"}', status: 500 });

    const response = await user.agent.post('/api/jobs/parse').send({ url: ADP_URL }).expect(422);

    expect(response.body.error.message).toMatch(/no job description/i);
    // API, then the shell page, then the reader.
    expect(calls).toHaveLength(3);
  });

  const GEM_URL = 'https://jobs.gem.com/chiri/am9icG9zdDqtkK2RuSE24okIC3uOdbVI';

  const GEM_POSTING = JSON.stringify({
    data: {
      oatsExternalJobPosting: {
        id: 'T2F0c0pvYlBvc3Q6NzcxMzQwMQ==',
        title: 'Mid-Level Full-Stack Engineer - .NET, Azure & AI',
        descriptionHtml:
          '<h1><strong style="color: rgb(255, 94, 14);">Why Chiri</strong></h1><div><br></div>' +
          '<div><span style="color: rgb(255, 255, 255);">Chiri works directly with organizations to turn that shift into working systems. ' +
          'Our forward-deployed teams operate inside the technologies and processes our clients already use.</span></div>' +
          '<h1><strong>Key Responsibilities</strong></h1><ul><li>Build and extend production applications using <strong>C#, .NET and React</strong>.</li><li>Own delivery end to end.</li></ul>',
        firstPublishedTsSec: 1788806421,
        locations: [
          { name: 'South America', city: '', isoCountry: null, isRemote: false },
          { name: 'Central America', city: '', isoCountry: null, isRemote: false },
        ],
        job: { locationType: 'REMOTE', employmentType: 'FULL_TIME', locations: [] },
        jobPostSectionHtml: { introHtml: null, outroHtml: '<h1><br></h1><h1><strong>Our SCOUT Values</strong></h1><div>Seek to Understand.</div>' },
        compensationHtml: null,
      },
    },
  });

  /** Gem's shell page, and its GraphQL API answering beside it. */
  function stubGem(api: { body: string; status?: number }) {
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
        if (url === 'https://jobs.gem.com/api/public/graphql') {
          return new Response(api.body, { status: api.status ?? 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.startsWith(env.JOB_READER_URL)) return new Response('', { status: 404 });
        return new Response('<html><head><title>Chiri Careers</title></head><body><div id="content"></div></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }),
    );
    return calls;
  }

  it('reads a Gem posting through the board\'s public GraphQL API', async () => {
    const user = await createUser();
    const calls = stubGem({ body: GEM_POSTING });

    const response = await user.agent.post('/api/jobs/parse').send({ url: GEM_URL }).expect(200);

    expect(response.body).toMatchObject({
      strategy: 'board',
      title: 'Mid-Level Full-Stack Engineer - .NET, Azure & AI',
      company: 'Chiri',
      location: 'Remote, South America, Central America',
      employmentType: 'Full Time',
      datePosted: '2026-09-07',
    });
    expect(response.body.description).toContain('# **Why Chiri**');
    expect(response.body.description).toContain('- Own delivery end to end.');
    // The board-wide outro follows the role's own description, minus the empty spacer heading.
    expect(response.body.description).toMatch(/Own delivery end to end\.[\s\S]*# \*\*Our SCOUT Values\*\*/);
    expect(response.body.description).not.toMatch(/^#\s*$/m);

    // One POST to the API, carrying the board and post ids; the shell page was never fetched.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      operationName: 'ExternalJobPosting',
      variables: { boardId: 'chiri', extId: 'am9icG9zdDqtkK2RuSE24okIC3uOdbVI' },
    });
  });

  it('falls through to the general path when Gem\'s API answers without a posting', async () => {
    const user = await createUser();
    const calls = stubGem({ body: '{"data":{"oatsExternalJobPosting":null}}' });

    const response = await user.agent.post('/api/jobs/parse').send({ url: GEM_URL }).expect(422);

    expect(response.body.error.message).toMatch(/no job description/i);
    // API, then the shell page, then the reader.
    expect(calls).toHaveLength(3);
  });

  const BAMBOO_URL = 'https://newsmatics.bamboohr.com/careers/53';

  const BAMBOO_DETAIL = JSON.stringify({
    meta: {},
    result: {
      jobOpening: {
        jobOpeningShareUrl: 'https://newsmatics.bamboohr.com/careers/53',
        jobOpeningName: 'Senior Developer - Data Products',
        jobOpeningStatus: 'Open',
        departmentLabel: 'Data Science Department (CZ)',
        employmentStatusLabel: 'Contractor',
        employmentType: null,
        location: { city: null, state: null, postalCode: null, addressCountry: null },
        atsLocation: { country: 'Czech Republic', countryId: '56', state: null, city: null },
        description:
          '<p><span style="font-weight: bold">About the Role</span></p>\n<p><br>We are looking for a senior developer to help build and improve Newsmatics\u2019 data-driven products for news discovery, media transparency, and monitoring.</p>\n' +
          '<p><span style="font-weight: bold">Responsibilities</span></p>\n<ul><li>Design and build backend services and APIs.</li><li>Own production delivery.</li></ul>',
        compensation: null,
        datePosted: '2026-09-07',
        minimumExperience: 'Senior Executive',
        locationType: '1',
      },
      formFields: { firstName: { isRequired: true, value: '', label: 'First Name' } },
    },
  });

  /** BambooHR's shell page, and its detail API answering beside it. */
  function stubBamboo(api: { body: string; status?: number }) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(url);
        if (/\/careers\/\d+\/detail$/.test(url)) {
          return new Response(api.body, { status: api.status ?? 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.startsWith(env.JOB_READER_URL)) return new Response('', { status: 404 });
        return new Response(
          '<html><head><meta property="og:title" content="Senior Developer - Data Products"/><meta property="og:site_name" content="Newsmatics"/></head><body><div id="poRoot"></div></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }),
    );
    return calls;
  }

  it('reads a BambooHR opening through the board\'s detail API', async () => {
    const user = await createUser();
    const calls = stubBamboo({ body: BAMBOO_DETAIL });

    const response = await user.agent.post('/api/jobs/parse').send({ url: BAMBOO_URL }).expect(200);

    expect(response.body).toMatchObject({
      strategy: 'board',
      title: 'Senior Developer - Data Products',
      company: 'Newsmatics',
      location: 'Remote, Czech Republic',
      employmentType: 'Contractor',
      datePosted: '2026-09-07',
    });
    expect(response.body.description).toContain('**About the Role**');
    expect(response.body.description).toContain('- Own production delivery.');
    // Only the API was asked; the shell page and the reader were not.
    expect(calls).toEqual(['https://newsmatics.bamboohr.com/careers/53/detail']);
  });

  it('reads the older BambooHR view.php URL the same way', async () => {
    const user = await createUser();
    const calls = stubBamboo({ body: BAMBOO_DETAIL });

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://newsmatics.bamboohr.com/jobs/view.php?id=53' })
      .expect(200);

    expect(response.body).toMatchObject({ strategy: 'board', title: 'Senior Developer - Data Products' });
    expect(calls).toEqual(['https://newsmatics.bamboohr.com/careers/53/detail']);
  });

  it('falls through to the general path when BambooHR\'s API fails', async () => {
    const user = await createUser();
    const calls = stubBamboo({ body: '{"error":"gone"}', status: 500 });

    const response = await user.agent.post('/api/jobs/parse').send({ url: BAMBOO_URL }).expect(422);

    expect(response.body.error.message).toMatch(/no job description/i);
    // API, then the shell page, then the reader.
    expect(calls).toHaveLength(3);
  });

  it('reads Markdown the reader sends as a plain body', async () => {
    const user = await createUser();
    stubFetch(
      '%PDF-1.7',
      { contentType: 'application/pdf' },
      {
        body: `## Data Engineer\n\n${'Build the pipelines that feed every dashboard we ship. '.repeat(6)}`,
        contentType: 'text/markdown',
      },
    );

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/posting.pdf' })
      .expect(200);

    expect(response.body.strategy).toBe('reader');
    expect(response.body.description).toContain('## Data Engineer');
  });

  it('ignores a reader answer too short to be a posting', async () => {
    const user = await createUser();
    stubFetch('<html>Forbidden</html>', { status: 403 }, {
      body: JSON.stringify({ data: { content: 'Sign in to view this job.' } }),
    });

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/private' })
      .expect(502);

    expect(response.body.error.message).toMatch(/signing in/i);
  });

  it('reports an upstream refusal as a 502 the user can act on', async () => {
    const user = await createUser();
    stubFetch('<html>Forbidden</html>', { status: 403 });

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/private' })
      .expect(502);

    expect(response.body.error.code).toBe('BAD_GATEWAY');
    expect(response.body.error.message).toMatch(/signing in/i);
  });

  it('refuses a URL that answers with something other than a web page', async () => {
    const user = await createUser();
    stubFetch('%PDF-1.7', { contentType: 'application/pdf' });

    const response = await user.agent
      .post('/api/jobs/parse')
      .send({ url: 'https://93.184.216.34/posting.pdf' })
      .expect(422);

    expect(response.body.error.message).toMatch(/not a web page/i);
  });
});
