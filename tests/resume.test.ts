import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdmin, createUser, request } from './helpers.js';
import { ResumePayloadSchema } from '../src/resume/resume.schemas.js';
import { buildResumeModel } from '../src/resume/template/model.js';
import { renderResumeHtml } from '../src/resume/template/html.js';
import { buildResumeDocx } from '../src/resume/template/docx.js';
import { fontFaceCss } from '../src/resume/template/fonts.js';
import { buildSystemPrompt, buildUserPrompt, DEFAULT_SYSTEM_PROMPT } from '../src/resume/prompt.js';
import * as providers from '../src/resume/providers/index.js';
import * as aiConfig from '../src/ai-config/ai-config.service.js';
import { resumeFileName } from '../src/resume/resume-file-name.js';
import type { Profile } from '../src/domain/types.js';

/**
 * No AI platform is called here. What is worth asserting without spending money
 * at a vendor is everything around the call: that the routes validate, that a
 * deployment with no key says so rather than crashing, that the prompt stays on
 * this side of the wire, and that the template renders what the model gives it.
 */

const PAYLOAD = ResumePayloadSchema.parse({
  company: 'Pipe',
  role: 'Senior Software Engineer',
  roleTitles: [
    'Senior Software Engineer',
    'Software Engineer',
    'Backend Software Engineer',
    'Software Engineer',
  ],
  summary:
    'Senior Software Engineer with 6+ years of experience building scalable backend platforms. ' +
    'Expert in Go, Python and PostgreSQL, with 38% lower latency and 99.95% availability. ' +
    'Effective remote collaborator who leads projects end-to-end across distributed teams.',
  skills: [
    'Languages: Go | Python | Java | TypeScript',
    'Cloud Platforms: AWS | GCP | Docker | Kubernetes',
    'Databases: PostgreSQL | MySQL | Redis | Data Modeling',
    'Backend Systems: REST APIs | Distributed Systems | Microservices',
    'Engineering Quality: System Design | Automated Testing | Observability',
    'Remote Leadership: Technical Leadership | Project Ownership | Remote-First Delivery',
  ],
  bullets: [
    ['First bullet.', 'Second bullet.', 'Third bullet.', 'Fourth bullet.', 'Fifth bullet.'],
    ['First bullet.', 'Second bullet.', 'Third bullet.', 'Fourth bullet.'],
    ['First bullet.', 'Second bullet.', 'Third bullet.'],
    ['First bullet.', 'Second bullet.'],
  ],
});

const PROFILE: Profile = {
  firstName: 'Jordan',
  middleName: '',
  lastName: 'Rivera',
  hasPreferredName: false,
  preferredFirstName: '',
  preferredLastName: '',
  dateOfBirth: '1994-04-02',
  resumeTemplateId: 'default.docx',
  location: 'Franklin, TN',
  addressLine: '',
  city: 'Franklin',
  state: 'TN',
  zipCode: '',
  county: '',
  country: 'United States',
  timezone: 'America/Chicago',
  linkedinUrl: '',
  githubUrl: '',
  portfolioUrl: '',
  otherUrl: '',
  email: 'jordan@example.com',
  phone: '(615) 825-1004',
  authorizedCountries: [],
  gender: '',
  ethnicity: '',
  disabilityStatus: '',
  veteranStatus: '',
  lgbtqIdentity: '',
  birthYear: '',
  securityClearance: '',
  drugTestWillingness: '',
  noticePeriod: '',
  openToRelocation: '',
  inPersonAvailability: '',
  requireAccommodations: '',
  workExperience: [
    { id: '1', company: 'Pipe', title: 'Engineer', location: 'Franklin, TN (Remote)', startDate: '2024-08', endDate: null },
    { id: '2', company: 'Northwind', title: 'Engineer', location: 'Remote', startDate: '2022-07', endDate: '2024-07' },
    { id: '3', company: 'Bluefin', title: 'Engineer', location: 'Remote', startDate: '2021-07', endDate: '2022-07' },
    { id: '4', company: 'Harbor', title: 'Engineer', location: 'Remote', startDate: '2020-01', endDate: '2021-06' },
  ],
  education: [
    {
      id: '1',
      degree: 'Bachelor of Science',
      major: 'Computer Science',
      university: 'Vanderbilt University',
      location: 'Nashville, TN',
      startDate: '2014-08',
      endDate: '2018-12',
    },
  ],
};

const VALID_BODY = {
  company: 'Acme Corp',
  role: 'Senior Backend Engineer',
  jobDescription: '<h2>About the role</h2><p>We are hiring a senior backend engineer.</p>',
};

describe('POST /api/resume/generate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires authentication', async () => {
    await request().post('/api/resume/generate').send(VALID_BODY).expect(401);
  });

  it('rejects a body with no job description', async () => {
    const user = await createUser();
    const response = await user.agent
      .post('/api/resume/generate')
      .send({ ...VALID_BODY, jobDescription: '' })
      .expect(400);

    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('answers 503, naming the variable, when the provider has no key', async () => {
    const user = await createUser();
    const response = await user.agent.post('/api/resume/generate').send(VALID_BODY).expect(503);

    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.error.message).toMatch(/OPENAI_API_KEY/);
  });

  it('returns the payload as JSON, not a file, and says which platform wrote it', async () => {
    const user = await createUser();

    // The config seam moved: `resolveAiConfig` now lives in the ai-config
    // service, which reads the admin's stored row before falling back to the
    // environment. The provider loader is still the other half of the stub.
    vi.spyOn(aiConfig, 'resolveAiConfig').mockResolvedValue({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 110_000,
    });
    vi.spyOn(providers, 'loadProvider').mockResolvedValue({
      generate: async () => PAYLOAD,
      // The conversation half of the platform, which these tests do not use.
      chat: async function* () {},
      listModels: async () => [],
    });

    const response = await user.agent.post('/api/resume/generate').send(VALID_BODY).expect(200);

    expect(response.headers['x-resume-provider']).toBe('openai');
    expect(response.body.document.roleTitles).toHaveLength(4);
    expect(response.body.document.bullets.map((g: string[]) => g.length)).toEqual([5, 4, 3, 2]);
  });
});

describe('POST /api/resume/render', () => {
  it('requires authentication', async () => {
    await request()
      .post('/api/resume/render')
      .send({ document: PAYLOAD, format: 'pdf' })
      .expect(401);
  });

  it('rejects a format that is not pdf or docx', async () => {
    const user = await createUser();
    await user.agent
      .post('/api/resume/render')
      .send({ document: PAYLOAD, format: 'rtf' })
      .expect(400);
  });

  it('rejects a payload that is not the template shape', async () => {
    const user = await createUser();
    await user.agent
      .post('/api/resume/render')
      .send({ document: { summary: 'just a summary' }, format: 'docx' })
      .expect(400);
  });

  it('renders a Word document', async () => {
    const user = await createUser();

    const response = await user.agent
      .post('/api/resume/render')
      .send({ document: PAYLOAD, format: 'docx' })
      // Without this superagent tries to parse the body as text; the file has
      // to come back as bytes to be checked at all.
      .responseType('blob')
      .expect(200)
      .expect(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );

    // A .docx is a zip; "PK" is the local file header every one starts with.
    expect(response.body.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('the Resume template', () => {
  it('takes the person from the profile and the tailoring from the payload', () => {
    const model = buildResumeModel(PROFILE, PAYLOAD);

    expect(model.name).toBe('Jordan Rivera');
    expect(model.personal).toEqual(['Franklin, TN', 'jordan@example.com', '(615) 825-1004']);
    // Titles are the AI's; the employer and its dates are the profile's.
    expect(model.jobs[0]!.title).toBe('Senior Software Engineer');
    // The employer, its location and its dates are three fields, because the
    // renderers put the last two against the right margin.
    expect(model.jobs[0]!.company).toBe('Pipe');
    expect(model.jobs[0]!.location).toBe('Franklin, TN (Remote)');
    expect(model.jobs[0]!.dates).toBe('Aug 2024 - Present');
    expect(model.jobs[1]!.dates).toBe('Jul 2022 - Jul 2024');
    expect(model.education).toEqual({
      degree: 'Bachelor of Science in Computer Science',
      school: 'Vanderbilt University - Nashville, TN',
      dates: 'Aug 2014 - Dec 2018',
    });
  });

  it('bolds the skill category, up to the first colon', () => {
    const html = renderResumeHtml(buildResumeModel(PROFILE, PAYLOAD));

    expect(html).toContain('<strong>Languages:</strong> Go | Python | Java | TypeScript');
  });

  it('escapes what it interpolates', () => {
    const html = renderResumeHtml(
      buildResumeModel({ ...PROFILE, firstName: '<script>', lastName: '' }, PAYLOAD),
    );

    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>a');
  });

  it('orders the sections the way a Resume is read: summary, skills, work experience, education', () => {
    const html = renderResumeHtml(buildResumeModel(PROFILE, PAYLOAD));
    const at = (heading: string) => html.indexOf(`<h2>${heading}</h2>`);

    expect(at('Summary')).toBeGreaterThan(-1);
    expect(at('Skills')).toBeGreaterThan(at('Summary'));
    expect(at('Work Experience')).toBeGreaterThan(at('Skills'));
    expect(at('Education')).toBeGreaterThan(at('Work Experience'));
  });

  it('gives the Word file the same order, and Word\'s own heading styles', async () => {
    const zip = await JSZip.loadAsync(await buildResumeDocx(PROFILE, PAYLOAD));
    const document = await zip.file('word/document.xml')!.async('string');
    const styles = await zip.file('word/styles.xml')!.async('string');

    // Every paragraph that carries a style, in the order Word will read them.
    const outline = [...document.matchAll(/<w:p>(?:(?!<\/w:p>).)*?<w:pStyle w:val="(Title|Heading\d)"\/>(?:(?!<\/w:p>).)*?<\/w:p>/gs)].map(
      (match) => ({
        style: match[1],
        text: [...match[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((run) => run[1]).join(''),
      }),
    );

    expect(outline).toEqual([
      { style: 'Title', text: 'Jordan Rivera' },
      { style: 'Heading1', text: 'SUMMARY' },
      { style: 'Heading1', text: 'SKILLS' },
      { style: 'Heading1', text: 'WORK EXPERIENCE' },
      { style: 'Heading1', text: 'EDUCATION' },
    ]);

    // Word ships its own Title and Heading 1 and this document redefines them;
    // two of either in one stylesheet is a file Word offers to repair.
    for (const id of ['Title', 'Heading1']) {
      expect([...styles.matchAll(new RegExp(`w:styleId="${id}"`, 'g'))]).toHaveLength(1);
    }
    // Redefined to this template's type: 12pt and near-black, not Word's blue 16pt.
    const heading = /<w:style [^>]*w:styleId="Heading1"[^>]*>(.*?)<\/w:style>/s.exec(styles)![1]!;
    expect(heading).toContain('<w:sz w:val="24"/>');
    expect(heading).toContain('<w:color w:val="1A1A1A"/>');
    expect(heading).not.toContain('2E74B5');

    // The right-hand half of a line is a right tab stop at the page's content
    // width — 7.5in in twips — and a tab, not a table: a parser reads a table
    // cell by cell.
    expect(document).toContain('<w:tab w:val="right" w:pos="10800"/>');
    expect(document).not.toContain('<w:tbl>');
    // Employer and dates, then role and location — the same order as the PDF.
    const lines = [...document.matchAll(/<w:p>.*?<\/w:p>/gs)].map((match) =>
      [...match[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((piece) => piece[1]).join(''),
    );
    const employer = lines.findIndex((line) => line.startsWith('Pipe'));
    expect(employer).toBeGreaterThan(-1);
    expect(lines[employer]).toContain('Aug 2024 - Present');
    expect(lines[employer + 1]).toContain('Senior Software Engineer');
    expect(lines[employer + 1]).toContain('Franklin, TN (Remote)');

    const school = lines.findIndex((line) => line.startsWith('Vanderbilt University'));
    expect(lines[school]).toContain('Aug 2014 - Dec 2018');
    expect(lines[school + 1]).toBe('Bachelor of Science in Computer Science');
  });

  it('prints the payload\'s Markdown as Word runs', async () => {
    const zip = await JSZip.loadAsync(
      await buildResumeDocx(PROFILE, { ...PAYLOAD, summary: 'Led the **billing** migration.' } as typeof PAYLOAD),
    );
    const document = await zip.file('word/document.xml')!.async('string');

    // Three runs, the middle one bold, and no asterisks anywhere.
    expect(document).toContain('<w:t xml:space="preserve">Led the </w:t>');
    expect(document).toMatch(/<w:b\/>(?:(?!<\/w:r>).)*billing/s);
    expect(document).not.toContain('**');
  });

  it('names the sections what a parser looks for, and says what each one is', () => {
    const html = renderResumeHtml(buildResumeModel(PROFILE, PAYLOAD));

    // The heading vocabulary, not a house style: "Core Skills" is a section an
    // applicant tracking system cannot name, and files nowhere.
    expect(html).toContain('<h2>Skills</h2>');
    expect(html).not.toContain('Core Skills');
    // Whose Resume it is, is the document's one h1.
    expect(html).toContain('<h1 class="name">Jordan Rivera</h1>');
    expect(html.match(/<h1/g)).toHaveLength(1);
    // Bullets are a list, not paragraphs that begin with a character.
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>');
    // Nothing a parser has to look at a picture to read, and no layout table.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<table');
  });

  it('keeps the template\'s page geometry and type', () => {
    const html = renderResumeHtml(buildResumeModel(PROFILE, PAYLOAD));

    expect(html).toContain('size: 8.5in 11in');
    expect(html).toContain('margin: 0.5in');
    expect(html).toContain('font-size: 10pt');
    expect(html).toContain('line-height: 1.4');
    // Carlito is embedded under Calibri's name, so the layout does not depend
    // on what fonts the host happens to have.
    expect(html).toContain("font-family: 'Calibri'");
    expect(html).toContain('data:font/woff2;base64,');
  });

  it('leaves alone what is not emphasis', () => {
    const html = renderResumeHtml(
      buildResumeModel(PROFILE, {
        ...PAYLOAD,
        summary:
          'Scaled 2 * 3 * 4 services, cut costs by 30% and kept 99.9\\* uptime.\n' +
          'Wrote C* and F# for a living; the *rest* was Go.',
      } as typeof PAYLOAD),
    );

    // A marker with a space after it is arithmetic, an escaped one is a
    // character, an unclosed one is punctuation — only the closed pair is
    // emphasis.
    expect(html).toContain('Scaled 2 * 3 * 4 services, cut costs by 30% and kept 99.9* uptime.');
    expect(html).toContain('Wrote C* and F# for a living; the <em>rest</em> was Go.');
  });

  it('sets each part of the page at the size the template specifies', async () => {
    const html = renderResumeHtml(buildResumeModel(PROFILE, PAYLOAD));
    const document = await (await JSZip.loadAsync(await buildResumeDocx(PROFILE, PAYLOAD)))
      .file('word/document.xml')!
      .async('string');

    // The stylesheet and the Word file are one template, so each size is
    // asserted in both. Word counts in half-points.
    const inWord = (text: string) =>
      new RegExp(`<w:sz w:val="(\\d+)"/>(?:(?!</w:r>).)*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 's').exec(document)?.[1];

    // Section titles 12pt, and the text under them 10pt — the document's
    // default, which the summary, the skills and the contact line inherit.
    expect(html).toContain('h2 {\n  font-size: 12pt;');
    expect(inWord('SUMMARY')).toBe('24');
    expect(html).toMatch(/body \{[^}]*font-size: 10pt;/);
    expect(document).toContain('<w:sz w:val="20"/>');

    // Work experience: the role 11.5pt, the employer 10.5pt, and the location
    // and dates beside them 10.5pt.
    expect(html).toContain('.role {\n  font-size: 11.5pt;');
    expect(html).toContain('.role .right {\n  font-size: 10.5pt;');
    expect(html).toContain('.company {\n  font-size: 10.5pt;');
    expect(inWord('Senior Software Engineer')).toBe('23');
    expect(inWord('Aug 2024 - Present')).toBe('21');
    expect(inWord('Pipe')).toBe('21');
    expect(inWord('Franklin, TN (Remote)')).toBe('21');

    // Bullets and the whole education section at 10pt.
    expect(html).toContain('.job li {\n  margin: 0;\n  font-size: 10pt;');
    expect(html).toContain('.degree {\n  font-size: 10pt;');
    expect(inWord('Bachelor of Science in Computer Science')).toBe('20');
    expect(inWord('Vanderbilt University - Nashville, TN')).toBe('20');
    expect(inWord('Aug 2014 - Dec 2018')).toBe('20');
  });

  it('sets the section headings in capitals without typing them that way', () => {
    const html = renderResumeHtml(buildResumeModel(PROFILE, PAYLOAD));

    // Capitals are a property of the type, so the text a parser reads is still
    // "Work Experience" — see *Written to be read by a machine first*.
    expect(html).toContain('<h2>Work Experience</h2>');
    expect(html).toContain('text-transform: uppercase');
  });

  it('reads employer then role, with the dates and the location against the right margin', () => {
    const html = renderResumeHtml(buildResumeModel(PROFILE, PAYLOAD));

    // The employer with its dates, the role with its location under it, and
    // education the same way round — the institution first, what was studied
    // there second. Each is one line, left half first, so the text of the page
    // still reads in order.
    const employer =
      '<p class="company spread"><span>Pipe</span><span class="right">Aug 2024 - Present</span></p>';
    const role =
      '<p class="role spread"><span>Senior Software Engineer</span><span class="right">Franklin, TN (Remote)</span></p>';
    expect(html).toContain(employer);
    expect(html).toContain(role);
    expect(html.indexOf(employer)).toBeLessThan(html.indexOf(role));

    const school =
      '<p class="edu-info spread"><span>Vanderbilt University - Nashville, TN</span><span class="right">Aug 2014 - Dec 2018</span></p>';
    const degree = '<p class="degree">Bachelor of Science in Computer Science</p>';
    expect(html).toContain(school);
    expect(html.indexOf(school)).toBeLessThan(html.indexOf(degree));

    // Nothing to put on the right is one span, not an empty one.
    expect(renderResumeHtml({ ...buildResumeModel(PROFILE, PAYLOAD), jobs: [{ title: 'Engineer', company: 'Acme', location: '', dates: '', bullets: [] }] }))
      .toContain('<p class="role">Engineer</p>');
  });

  it('prints the Markdown the payload is written in, rather than its markers', () => {
    const html = renderResumeHtml(
      buildResumeModel(PROFILE, {
        ...PAYLOAD,
        summary: 'Led the **billing** migration and *the* team behind it.',
        skills: ['**Languages:** Go, `Rust`'],
        bullets: [['Cut latency by ***60%*** — see [the write-up](https://example.test/x).']],
        roleTitles: ['Senior **Staff** Engineer'],
      } as typeof PAYLOAD),
    );

    expect(html).toContain('Led the <strong>billing</strong> migration and <em>the</em> team behind it.');
    // The category is bold once, whether or not the payload asked for it.
    expect(html).toContain('<strong>Languages:</strong> Go, Rust');
    expect(html).toContain('Cut latency by <strong><em>60%</em></strong>');
    // A link is its text: a URL is of no use on a printed page.
    expect(html).toContain('see the write-up.');
    expect(html).toContain('Senior <strong>Staff</strong> Engineer');
    expect(html).not.toContain('**');
    expect(html).not.toContain('`Rust`');
  });

  it('renders a Word file from the same model', async () => {
    const docx = await buildResumeDocx(PROFILE, PAYLOAD);

    expect(docx.subarray(0, 2).toString()).toBe('PK');
    expect(docx.byteLength).toBeGreaterThan(1000);
  });

  it('renders when the profile has no employers or education', async () => {
    const bare: Profile = { ...PROFILE, workExperience: [], education: [] };
    const model = buildResumeModel(bare, PAYLOAD);

    expect(model.education).toBeNull();
    // The bullets still print; they simply have no employer line above them.
    expect(model.jobs[0]!.company).toBe('');
    expect(model.jobs[0]!.dates).toBe('');
    expect((await buildResumeDocx(bare, PAYLOAD)).byteLength).toBeGreaterThan(1000);
  });
});

describe('GET /api/bids/:id/resume', () => {
  const bid = (overrides: Record<string, unknown> = {}) => ({
    company: 'Acme Corp',
    role: 'Senior Backend Engineer',
    location: 'Remote',
    bidDate: '2026-08-01',
    status: 'Applied',
    ...overrides,
  });

  it('requires authentication', async () => {
    await request().get('/api/bids/00000000-0000-4000-8000-000000000000/resume').expect(401);
  });

  it('404s an application saved without a Resume', async () => {
    const user = await createUser();
    const created = await user.agent.post('/api/bids').send(bid()).expect(201);

    const response = await user.agent
      .get(`/api/bids/${created.body.id}/resume`)
      .expect(404);

    expect(response.body.error.message).toMatch(/no Resume/i);
  });

  it('stores the Resume with the bid and reports it in the list', async () => {
    const user = await createUser();
    const created = await user.agent
      .post('/api/bids')
      .send(bid({ resumeDocument: PAYLOAD }))
      .expect(201);

    expect(created.body.hasResume).toBe(true);
    // The list carries the flag, never the document -- every screen loads it.
    const list = await user.agent.get('/api/bids').expect(200);
    const listed = list.body.find((b: { id: string }) => b.id === created.body.id);
    expect(listed.hasResume).toBe(true);
    expect(listed.resumeDocument).toBeUndefined();
  });

  it('downloads the stored Resume as Word', async () => {
    const user = await createUser();
    const created = await user.agent
      .post('/api/bids')
      .send(bid({ resumeDocument: PAYLOAD }))
      .expect(201);

    const response = await user.agent
      .get(`/api/bids/${created.body.id}/resume?format=docx`)
      .responseType('blob')
      .expect(200);

    expect(response.headers['content-disposition']).toMatch(/attachment/);
    expect(response.body.subarray(0, 2).toString()).toBe('PK');
  });

  it('does not hand one account\'s Resume to another', async () => {
    const owner = await createUser();
    const other = await createUser();
    const created = await owner.agent
      .post('/api/bids')
      .send(bid({ resumeDocument: PAYLOAD }))
      .expect(201);

    await other.agent.get(`/api/bids/${created.body.id}/resume`).expect(404);
  });

  it('clears the stored Resume when the update sends null', async () => {
    const user = await createUser();
    const created = await user.agent
      .post('/api/bids')
      .send(bid({ resumeDocument: PAYLOAD }))
      .expect(201);

    const updated = await user.agent
      .patch(`/api/bids/${created.body.id}`)
      .send({ resumeDocument: null })
      .expect(200);

    expect(updated.body.hasResume).toBeUndefined();
    await user.agent.get(`/api/bids/${created.body.id}/resume`).expect(404);
  });
});

/**
 * `Andrew Zhu.pdf` — the one name a Resume carries, whether it was downloaded
 * from the form or from a row in the table: the candidate's name and nothing
 * else.
 */
describe('the Resume file name', () => {
  it('is the candidate name and the extension, and nothing else', () => {
    expect(resumeFileName({ firstName: 'Andrew', lastName: 'Zhu', extension: 'pdf' })).toBe('Andrew Zhu.pdf');
    expect(resumeFileName({ firstName: 'Andrew', lastName: 'Zhu', extension: 'docx' })).toBe('Andrew Zhu.docx');
  });

  it('replaces what a filename cannot carry, and collapses the result', () => {
    expect(
      resumeFileName({ firstName: 'Ana  María', lastName: "O'Neill/Smith", extension: 'docx' }),
    ).toBe("Ana María O'Neill Smith.docx");
  });

  it('does not end the name in a dot or a space', () => {
    expect(resumeFileName({ firstName: 'Andrew', lastName: 'Zhu .', extension: 'pdf' })).toBe('Andrew Zhu.pdf');
  });

  it('keeps a dot inside the name, where it belongs', () => {
    expect(resumeFileName({ firstName: 'A.J.', lastName: 'Cronin', extension: 'pdf' })).toBe('A.J. Cronin.pdf');
  });

  it('manages with half a name', () => {
    expect(resumeFileName({ firstName: 'Prince', lastName: '', extension: 'pdf' })).toBe('Prince.pdf');
    expect(resumeFileName({ firstName: '', lastName: 'Zhu', extension: 'pdf' })).toBe('Zhu.pdf');
  });

  it('never produces a name that is only an extension', () => {
    expect(resumeFileName({ firstName: ' ', lastName: '', extension: 'pdf' })).toBe('resume.pdf');
    expect(resumeFileName({ firstName: '', lastName: '', extension: 'pdf', fallback: 'cover-letter' })).toBe(
      'cover-letter.pdf',
    );
  });
});

/**
 * The name on the way out of the API, which is what a browser saves when it
 * downloads a stored Resume rather than one the page already holds.
 */
describe('the download header', () => {
  it('names the file after the candidate', async () => {
    const user = await createUser();

    await user.agent.put('/api/profile').send({
      firstName: 'Andrew',
      lastName: 'Zhu',
      dateOfBirth: '',
      location: '',
      email: 'a@b.com',
      phone: '',
      workExperience: [],
      education: [],
    });

    const created = await user.agent
      .post('/api/bids')
      .send({
        company: 'Acme Corp',
        role: 'Senior Backend Engineer',
        location: 'Remote',
        bidDate: '2026-08-01',
        status: 'Applied',
        resumeDocument: PAYLOAD,
      })
      .expect(201);

    const response = await user.agent
      .get(`/api/bids/${created.body.id}/resume?format=docx`)
      .expect(200);

    const disposition = response.headers['content-disposition'];
    expect(disposition).toContain('attachment;');
    // The candidate's name alone — not the company or the role the document
    // was written for, both of which the recruiter receiving it already knows.
    expect(disposition).toContain('filename="Andrew Zhu.docx"');
    // Both forms, so a name with an accent survives the ones that read RFC 5987
    // and degrades legibly on the ones that do not.
    expect(disposition).toContain("filename*=UTF-8''");
  });
});

/**
 * Admin-only: the picker lists against the deployment's key, and the catalogue
 * of a paid account is not something a candidate has any business enumerating.
 */
describe('POST /api/resume/models', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires authentication', async () => {
    await request().post('/api/resume/models').send({ provider: 'openai' }).expect(401);
  });

  it('is refused for a plain account', async () => {
    const user = await createUser();
    const response = await user.agent
      .post('/api/resume/models')
      .send({ provider: 'openai' })
      .expect(403);

    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a platform that is not one of the three', async () => {
    const user = await createAdmin();
    await user.agent.post('/api/resume/models').send({ provider: 'llama' }).expect(400);
  });

  it('answers 503 when no key is supplied and none is configured', async () => {
    const user = await createAdmin();
    const response = await user.agent
      .post('/api/resume/models')
      .send({ provider: 'anthropic' })
      .expect(503);

    expect(response.body.error.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('lists the platform\'s models, and what a picker should land on', async () => {
    const user = await createAdmin();

    const listModels = vi.fn(async () => [
      { id: 'gpt-5', displayName: 'gpt-5' },
      { id: 'gpt-4o', displayName: 'gpt-4o' },
    ]);
    vi.spyOn(providers, 'loadProvider').mockResolvedValue({
      generate: async () => PAYLOAD,
      chat: async function* () {},
      listModels,
    });

    const response = await user.agent
      .post('/api/resume/models')
      .send({ provider: 'openai', apiKey: 'sk-typed-into-the-form' })
      .expect(200);

    expect(response.body.models).toHaveLength(2);
    expect(response.body.defaultModel).toBe('gpt-5');
    // The key from the body is what the platform is called with, not the
    // environment's -- that is the whole point of the admin flow.
    expect(listModels).toHaveBeenCalledWith('sk-typed-into-the-form');
  });

  it('blames the key, not the gateway, when the platform rejects it', async () => {
    const user = await createAdmin();

    vi.spyOn(providers, 'loadProvider').mockResolvedValue({
      generate: async () => PAYLOAD,
      // The conversation half of the platform, which these tests do not use.
      chat: async function* () {},
      listModels: async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
    });

    const response = await user.agent
      .post('/api/resume/models')
      .send({ provider: 'openai', apiKey: 'sk-wrong' })
      .expect(400);

    expect(response.body.error.message).toMatch(/rejected by openai/i);
  });
});

describe('the embedded fonts', () => {
  it('needs no file at runtime, which is what broke in production', () => {
    // Comments stripped: this file explains the bug it is guarding against, and
    // the explanation names the very calls being looked for.
    const code = readFileSync('src/resume/template/fonts.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // `require.resolve` of a .woff2 is not something a serverless bundler can
    // follow, so the function shipped without its fonts and every render threw
    // MODULE_NOT_FOUND. An import is followed; nothing else may creep back in.
    expect(code).not.toMatch(/require\.resolve|readFileSync|createRequire/);
  });

  it('declares all four faces under Calibri, as data URIs', () => {
    const css = fontFaceCss();

    expect(css.match(/@font-face/g)).toHaveLength(4);
    expect(css.match(/data:font\/woff2;base64,/g)).toHaveLength(4);
    // The template asks for Calibri; Carlito answers to that name.
    expect(css).toContain("font-family: 'Calibri'");
  });

  it('still matches the installed @fontsource/carlito', async () => {
    // Guards the one hazard of a generated file: the dependency moving on
    // without it. Fails loudly rather than shipping stale glyph metrics.
    const { buildFontDataSource } = await import('../scripts/generate-font-data.mjs');

    expect(readFileSync('src/resume/template/font-data.ts', 'utf8')).toBe(buildFontDataSource());
  });
});

describe('the prompt', () => {
  it('is Markdown, and asks for the template\'s JSON shape', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('# Strict Document Layout and Text Rules');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## V. Output format');
    for (const field of ['roleTitles', 'summary', 'skills', 'bullets']) {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(field);
    }
  });

  it('sends the three inputs and nothing else', () => {
    const user = buildUserPrompt({
      company: 'Acme Corp',
      role: 'Senior Backend Engineer',
      jobDescription: 'We are hiring.',
    });

    expect(user).toContain('Acme Corp');
    expect(user).toContain('Senior Backend Engineer');
    expect(user).toContain('We are hiring.');
    expect(buildSystemPrompt()).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});
