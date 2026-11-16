import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdmin, createUser, request } from './helpers.js';
import { ResumePayloadSchema } from '../src/resume/resume.schemas.js';
import { CoverLetterPayloadSchema } from '../src/cover-letter/cover-letter.schemas.js';
import { buildCoverLetterModel, parseSpans } from '../src/cover-letter/template/model.js';
import { renderCoverLetterHtml } from '../src/cover-letter/template/html.js';
import { buildCoverLetterDocx } from '../src/cover-letter/template/docx.js';
import {
  buildCoverLetterUserPrompt,
  DEFAULT_COVER_LETTER_PROMPT,
} from '../src/cover-letter/prompt.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/resume/prompt.js';
import { resumeFileName } from '../src/resume/resume-file-name.js';
import * as providers from '../src/resume/providers/index.js';
import * as aiConfig from '../src/ai-config/ai-config.service.js';
import type { Profile } from '../src/domain/types.js';

/**
 * No AI platform is called here, for the same reason the Resume's tests do not
 * call one: what is worth asserting without spending money at a vendor is
 * everything around the call — that the routes validate, that a deployment with
 * no key says so, that the prompt stays on this side of the wire, and that the
 * template lays out what the model gives it.
 */

const RESUME = ResumePayloadSchema.parse({
  company: 'Pipe',
  role: 'Senior Software Engineer',
  roleTitles: ['Senior Software Engineer', 'Software Engineer'],
  summary: 'Senior Software Engineer with 6 years of experience building backend platforms.',
  skills: ['Languages: Go | Python'],
  bullets: [['First bullet.'], ['Second bullet.']],
});

const LETTER = CoverLetterPayloadSchema.parse({
  company: 'Pipe',
  role: 'Senior Software Engineer',
  greeting: 'Dear Hiring Manager,',
  paragraphs: [
    'I am applying for the Senior Software Engineer role with 6 years of experience.',
    'At my current employer I **reduced latency by 30%** across the payments platform.',
    'I mentor junior developers across 4 time zones and document every decision.',
    'I would welcome a conversation about your engineering pipeline.',
  ],
  closing: 'Sincerely,',
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
  workExperience: [],
  education: [],
};

const VALID_BODY = {
  company: 'Acme Corp',
  role: 'Senior Backend Engineer',
  jobDescription: '<h2>About the role</h2><p>We are hiring a senior backend engineer.</p>',
  resume: RESUME,
};

describe('POST /api/cover-letter/generate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires authentication', async () => {
    await request().post('/api/cover-letter/generate').send(VALID_BODY).expect(401);
  });

  it('rejects a body with no Resume to write the letter from', async () => {
    const user = await createUser();
    const { resume: _resume, ...withoutResume } = VALID_BODY;

    const response = await user.agent
      .post('/api/cover-letter/generate')
      .send(withoutResume)
      .expect(400);

    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a body with no job description', async () => {
    const user = await createUser();
    await user.agent
      .post('/api/cover-letter/generate')
      .send({ ...VALID_BODY, jobDescription: '' })
      .expect(400);
  });

  it('answers 503, naming the variable, when the provider has no key', async () => {
    const user = await createUser();
    const response = await user.agent
      .post('/api/cover-letter/generate')
      .send(VALID_BODY)
      .expect(503);

    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.error.message).toMatch(/OPENAI_API_KEY/);
  });

  it('returns the letter as JSON, not a file, and says which platform wrote it', async () => {
    const user = await createUser();

    vi.spyOn(aiConfig, 'resolveAiConfig').mockResolvedValue({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 110_000,
    });
    vi.spyOn(providers, 'loadProvider').mockResolvedValue({
      generate: async () => LETTER,
      chat: async function* () {},
      listModels: async () => [],
    });

    const response = await user.agent
      .post('/api/cover-letter/generate')
      .send(VALID_BODY)
      .expect(200);

    expect(response.headers['x-resume-provider']).toBe('openai');
    expect(response.body.document.paragraphs).toHaveLength(4);
  });

  it('is written with its own prompt, not the Resume\'s', async () => {
    const user = await createUser();

    // The two settings are independent, so overriding the Resume's prompt must
    // leave the letter's alone — this is the assertion that would fail if the
    // service reached for `resolveSystemPrompt`.
    const coverLetterPrompt = vi
      .spyOn(aiConfig, 'resolveCoverLetterPrompt')
      .mockResolvedValue('a cover letter prompt');
    const systemPrompt = vi.spyOn(aiConfig, 'resolveSystemPrompt');

    vi.spyOn(aiConfig, 'resolveAiConfig').mockResolvedValue({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 110_000,
    });

    let seenSystem = '';
    vi.spyOn(providers, 'loadProvider').mockResolvedValue({
      generate: async (_config, request) => {
        seenSystem = request.system;
        return LETTER;
      },
      chat: async function* () {},
      listModels: async () => [],
    });

    await user.agent.post('/api/cover-letter/generate').send(VALID_BODY).expect(200);

    expect(coverLetterPrompt).toHaveBeenCalled();
    expect(systemPrompt).not.toHaveBeenCalled();
    expect(seenSystem).toBe('a cover letter prompt');
  });
});

describe('POST /api/cover-letter/render', () => {
  it('requires authentication', async () => {
    await request()
      .post('/api/cover-letter/render')
      .send({ document: LETTER, format: 'pdf' })
      .expect(401);
  });

  it('rejects a format that is not pdf or docx', async () => {
    const user = await createUser();
    await user.agent
      .post('/api/cover-letter/render')
      .send({ document: LETTER, format: 'rtf' })
      .expect(400);
  });

  it('rejects a payload that is not the template shape', async () => {
    const user = await createUser();
    await user.agent
      .post('/api/cover-letter/render')
      .send({ document: { greeting: 'Hello,' }, format: 'docx' })
      .expect(400);
  });

  it('renders a Word document', async () => {
    const user = await createUser();

    const response = await user.agent
      .post('/api/cover-letter/render')
      .send({ document: LETTER, format: 'docx' })
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

describe('the cover letter prompt', () => {
  it('never leaves the server', async () => {
    const user = await createUser();

    // The Resume's prompt is not on the settings screen for a plain account and
    // the letter's must not be either — both are admin-only, and neither is
    // embedded in a generation response.
    await user.agent.get('/api/admin/ai').expect(403);
  });

  it('hands the Resume to the model as the JSON it wrote', () => {
    const prompt = buildCoverLetterUserPrompt({
      company: 'Acme Corp',
      role: 'Senior Backend Engineer',
      jobDescription: 'We are hiring.',
      resume: RESUME,
    });

    expect(prompt).toContain('Job title: Senior Backend Engineer');
    expect(prompt).toContain('Company: Acme Corp');
    expect(prompt).toContain('"summary"');
    // The description goes last, under the Resume it is being read against.
    expect(prompt.indexOf('My resume:')).toBeLessThan(prompt.indexOf('Job description:'));
  });

  it('asks for the four paragraphs and the character rules', () => {
    expect(DEFAULT_COVER_LETTER_PROMPT).toContain('The Hook');
    expect(DEFAULT_COVER_LETTER_PROMPT).toContain('The Call to Action');
    expect(DEFAULT_COVER_LETTER_PROMPT).toContain('"paragraphs"');
  });
});

describe('the cover letter template', () => {
  it('takes the person from the profile and the letter from the payload', () => {
    const model = buildCoverLetterModel(PROFILE, LETTER, { date: '2026-09-02' });

    expect(model.name).toBe('Jordan Rivera');
    expect(model.signature).toBe('Jordan Rivera');
    expect(model.personal).toEqual(['Franklin, TN', 'jordan@example.com', '(615) 825-1004']);
    expect(model.date).toBe('September 2, 2026');
    expect(model.recipient).toEqual(['Hiring Team, Pipe', 'Re: Senior Software Engineer']);
    expect(model.paragraphs).toHaveLength(4);
  });

  it('turns **bold** into runs rather than printing the markers', () => {
    expect(parseSpans('At my employer I **cut latency by 30%** across payments.')).toEqual([
      { text: 'At my employer I ', bold: false },
      { text: 'cut latency by 30%', bold: true },
      { text: ' across payments.', bold: false },
    ]);
  });

  it('leaves an unclosed marker as literal text', () => {
    // A stray marker should cost two visible asterisks, not a paragraph that is
    // bold to the end of itself.
    expect(parseSpans('Half a **marker here')).toEqual([
      { text: 'Half a **marker here', bold: false },
    ]);
  });

  it('drops empty paragraphs rather than printing their spacing', () => {
    const model = buildCoverLetterModel(
      PROFILE,
      { ...LETTER, paragraphs: ['One.', '   ', 'Two.'] },
      {},
    );

    expect(model.paragraphs).toHaveLength(2);
    // No date supplied and none invented for the model — the service is what
    // falls back to today.
    expect(model.date).toBe('');
  });

  it('escapes what it interpolates', () => {
    const html = renderCoverLetterHtml(
      buildCoverLetterModel({ ...PROFILE, firstName: '<script>', lastName: '' }, LETTER),
    );

    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>a');
  });

  it("keeps the Resume's page geometry so the two documents match", () => {
    const html = renderCoverLetterHtml(buildCoverLetterModel(PROFILE, LETTER));

    expect(html).toContain('size: 8.5in 11in');
    expect(html).toContain('margin: 0.5in');
    // A point larger than the Resume: a letter is read as prose, not scanned.
    expect(html).toContain('font-size: 11pt');
    expect(html).toContain("font-family: 'Calibri'");
    expect(html).toContain('data:font/woff2;base64,');
    // The bold run survives into the markup, and its markers do not.
    expect(html).toContain('<b>reduced latency by 30%</b>');
    expect(html).not.toContain('**');
  });

  it('renders a Word file from the same model', async () => {
    const docx = await buildCoverLetterDocx(PROFILE, LETTER, { date: '2026-09-02' });

    expect(docx.subarray(0, 2).toString()).toBe('PK');
    expect(docx.byteLength).toBeGreaterThan(1000);
  });

  it('renders when the profile has no contact details', async () => {
    const bare: Profile = { ...PROFILE, location: '', email: '', phone: '' };
    const model = buildCoverLetterModel(bare, LETTER);

    expect(model.personal).toEqual([]);
    expect((await buildCoverLetterDocx(bare, LETTER)).byteLength).toBeGreaterThan(1000);
  });
});

/**
 * `Andrew Zhu.docx` — the same name the Resume carries. Which document it is,
 * is plain from opening it; whose it is, is not.
 */
describe('the cover letter file name', () => {
  it('is the candidate name, exactly as the Resume is named', () => {
    expect(resumeFileName({ firstName: 'Andrew', lastName: 'Zhu', extension: 'docx', fallback: 'cover-letter' })).toBe(
      'Andrew Zhu.docx',
    );
  });

  it('falls back to the kind of document rather than to "resume"', () => {
    expect(resumeFileName({ firstName: '', lastName: '', extension: 'pdf', fallback: 'cover-letter' })).toBe(
      'cover-letter.pdf',
    );
  });
});

/**
 * The name in the prompt is a placeholder; the name on the file is built from
 * the candidate's own profile. These two facts are easy to let drift apart, so
 * this asserts the second.
 */
describe('the cover letter download header', () => {
  it('names the file after the candidate', async () => {
    const user = await createUser();

    await user.agent.put('/api/profile').send({
      firstName: 'Rosa',
      lastName: 'Delgado',
      dateOfBirth: '',
      location: '',
      email: 'rosa@example.com',
      phone: '',
      workExperience: [],
      education: [],
    });

    const created = await user.agent
      .post('/api/bids')
      .send({
        company: 'Acme Corp',
        role: 'Staff Engineer',
        location: 'Remote',
        bidDate: '2026-08-01',
        status: 'Applied',
        // The letter names its own company and role, and they win over the
        // bid's — it is what will actually be sent.
        coverLetterDocument: LETTER,
      })
      .expect(201);

    const response = await user.agent
      .get(`/api/bids/${created.body.id}/cover-letter?format=docx`)
      .responseType('blob')
      .expect(200);

    // The profile's name, not the one written into the default prompt — and
    // not the company or the role the letter was written for.
    expect(response.headers['content-disposition']).toContain('filename="Rosa Delgado.docx"');
  });

  it('is the same name for a letter that names no company or role', async () => {
    const user = await createUser();

    await user.agent.put('/api/profile').send({
      firstName: 'Rosa',
      lastName: 'Delgado',
      dateOfBirth: '',
      location: '',
      email: 'rosa@example.com',
      phone: '',
      workExperience: [],
      education: [],
    });

    const created = await user.agent
      .post('/api/bids')
      .send({
        company: 'Acme Corp',
        role: 'Staff Engineer',
        location: 'Remote',
        bidDate: '2026-08-01',
        status: 'Applied',
        coverLetterDocument: { ...LETTER, company: '', role: '' },
      })
      .expect(201);

    const response = await user.agent
      .get(`/api/bids/${created.body.id}/cover-letter?format=docx`)
      .responseType('blob')
      .expect(200);

    // Nothing about the document reaches the file name any more, so a letter
    // with nothing written in it is named exactly like one that is complete.
    expect(response.headers['content-disposition']).toContain('filename="Rosa Delgado.docx"');
  });
});

describe('GET /api/bids/:id/cover-letter', () => {
  const bid = (overrides: Record<string, unknown> = {}) => ({
    company: 'Acme Corp',
    role: 'Senior Backend Engineer',
    location: 'Remote',
    bidDate: '2026-08-01',
    status: 'Applied',
    ...overrides,
  });

  it('requires authentication', async () => {
    await request().get('/api/bids/00000000-0000-4000-8000-000000000000/cover-letter').expect(401);
  });

  it('404s an application saved without a cover letter', async () => {
    const user = await createUser();
    const created = await user.agent.post('/api/bids').send(bid()).expect(201);

    const response = await user.agent
      .get(`/api/bids/${created.body.id}/cover-letter`)
      .expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('stores the letter with the application and flags it on the list', async () => {
    const user = await createUser();

    const created = await user.agent
      .post('/api/bids')
      .send(bid({ coverLetterDocument: LETTER }))
      .expect(201);

    expect(created.body.hasCoverLetter).toBe(true);
    // The document itself is written but never read back, exactly like the
    // Resume's — only the flag travels.
    expect(created.body.coverLetterDocument).toBeUndefined();

    const response = await user.agent
      .get(`/api/bids/${created.body.id}/cover-letter?format=docx`)
      .responseType('blob')
      .expect(200);

    expect(response.body.subarray(0, 2).toString()).toBe('PK');
    expect(response.headers['content-disposition']).toContain('.docx"');
  });

  it("is another account's 404, not their file", async () => {
    const owner = await createUser();
    const stranger = await createUser();

    const created = await owner.agent
      .post('/api/bids')
      .send(bid({ coverLetterDocument: LETTER }))
      .expect(201);

    await stranger.agent.get(`/api/bids/${created.body.id}/cover-letter`).expect(404);
  });
});

/**
 * The two prompts are two settings, and the whole point of that is that neither
 * can be changed by touching the other.
 */
describe('the cover letter prompt as an AI setting', () => {
  it('starts as the built-in default, marked as not overridden', async () => {
    const admin = await createAdmin();
    const response = await admin.agent.get('/api/admin/ai').expect(200);

    expect(response.body.coverLetterPrompt).toBe(DEFAULT_COVER_LETTER_PROMPT);
    expect(response.body.overrides.coverLetterPrompt).toBe(false);
  });

  it('is saved and reset independently of the Resume\'s', async () => {
    const admin = await createAdmin();

    const saved = await admin.agent
      .put('/api/admin/ai')
      .send({ coverLetterPrompt: 'Write a letter.' })
      .expect(200);

    expect(saved.body.coverLetterPrompt).toBe('Write a letter.');
    expect(saved.body.overrides.coverLetterPrompt).toBe(true);
    // The Resume's is untouched by a save that did not mention it.
    expect(saved.body.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(saved.body.overrides.systemPrompt).toBe(false);

    // And resetting the Resume's leaves the letter's alone, which is the half
    // that a single shared prompt column would get wrong.
    const afterResumeReset = await admin.agent
      .put('/api/admin/ai')
      .send({ systemPrompt: null })
      .expect(200);

    expect(afterResumeReset.body.coverLetterPrompt).toBe('Write a letter.');

    const cleared = await admin.agent
      .put('/api/admin/ai')
      .send({ coverLetterPrompt: null })
      .expect(200);

    expect(cleared.body.coverLetterPrompt).toBe(DEFAULT_COVER_LETTER_PROMPT);
    expect(cleared.body.overrides.coverLetterPrompt).toBe(false);
  });

  it('is what generation actually reads', async () => {
    const admin = await createAdmin();
    await admin.agent
      .put('/api/admin/ai')
      .send({ coverLetterPrompt: 'Stored letter prompt.' })
      .expect(200);

    await expect(aiConfig.resolveCoverLetterPrompt()).resolves.toBe('Stored letter prompt.');
    // The Resume's reader is unaffected by it.
    await expect(aiConfig.resolveSystemPrompt()).resolves.toBe(DEFAULT_SYSTEM_PROMPT);
  });
});
