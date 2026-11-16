import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdmin, createUser, request } from './helpers.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/resume/prompt.js';
import { DEFAULT_COVER_LETTER_PROMPT } from '../src/cover-letter/prompt.js';
import * as aiConfig from '../src/ai-config/ai-config.service.js';
import * as providers from '../src/resume/providers/index.js';
import { ResumePayloadSchema } from '../src/resume/resume.schemas.js';

/**
 * One profile's prompts, layered over the deployment's — the second AI
 * settings screen. What is worth asserting is the layering itself: that each
 * prompt falls back on its own, that only an admin reaches any of it, and that
 * generation reads the profile's prompt rather than the deployment's.
 */

const PAYLOAD = ResumePayloadSchema.parse({
  company: 'Acme',
  role: 'Engineer',
  roleTitles: ['a', 'b', 'c', 'd'],
  summary: 'Summary.',
  skills: ['Languages: Go'],
  bullets: [['1', '2', '3', '4', '5'], ['1', '2', '3', '4'], ['1', '2', '3'], ['1', '2']],
});

const promptsPath = (userId: string) => `/api/admin/users/${userId}/ai-prompts`;

describe('GET /api/admin/users/:id/ai-prompts', () => {
  it('starts as the deployment\'s prompts, marked as not overridden', async () => {
    const admin = await createAdmin();
    const user = await createUser();
    const response = await admin.agent.get(promptsPath(user.id)).expect(200);

    expect(response.body).toMatchObject({
      userId: user.id,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      coverLetterPrompt: DEFAULT_COVER_LETTER_PROMPT,
      overrides: { systemPrompt: false, coverLetterPrompt: false },
      updatedAt: null,
    });
    expect(response.body.defaults.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('shows the deployment\'s stored prompt as the default once one is set', async () => {
    const admin = await createAdmin();
    const user = await createUser();
    await admin.agent.put('/api/admin/ai').send({ systemPrompt: 'Deployment Resume prompt.' }).expect(200);

    const response = await admin.agent.get(promptsPath(user.id)).expect(200);
    expect(response.body.systemPrompt).toBe('Deployment Resume prompt.');
    expect(response.body.overrides.systemPrompt).toBe(false);
    expect(response.body.defaults.systemPrompt).toBe('Deployment Resume prompt.');
  });

  it('404s an account that does not exist', async () => {
    const admin = await createAdmin();
    await admin.agent.get(promptsPath('00000000-0000-4000-8000-000000000000')).expect(404);
  });

  it('is admin-only: a candidate does not see even their own', async () => {
    const user = await createUser();
    await user.agent.get(promptsPath(user.id)).expect(403);
    await user.agent.put(promptsPath(user.id)).send({ systemPrompt: 'Mine.' }).expect(403);
    // And there is no self-service route to fall back on.
    await user.agent.get('/api/ai-prompts').expect(404);
  });

  it('requires authentication', async () => {
    const user = await createUser();
    await request().get(promptsPath(user.id)).expect(401);
  });
});

describe('PUT /api/admin/users/:id/ai-prompts', () => {
  it('saves and resets each prompt independently', async () => {
    const admin = await createAdmin();
    const user = await createUser();

    const saved = await admin.agent
      .put(promptsPath(user.id))
      .send({ systemPrompt: 'Their Resume prompt.' })
      .expect(200);
    expect(saved.body.userId).toBe(user.id);
    expect(saved.body.systemPrompt).toBe('Their Resume prompt.');
    expect(saved.body.overrides).toEqual({ systemPrompt: true, coverLetterPrompt: false });
    expect(saved.body.coverLetterPrompt).toBe(DEFAULT_COVER_LETTER_PROMPT);
    expect(saved.body.updatedAt).not.toBeNull();

    // A save that does not mention the Resume's leaves it alone.
    const letter = await admin.agent
      .put(promptsPath(user.id))
      .send({ coverLetterPrompt: 'Their letter prompt.' })
      .expect(200);
    expect(letter.body.systemPrompt).toBe('Their Resume prompt.');
    expect(letter.body.coverLetterPrompt).toBe('Their letter prompt.');

    // Clearing one hands it back to the deployment and leaves the other.
    const cleared = await admin.agent.put(promptsPath(user.id)).send({ systemPrompt: null }).expect(200);
    expect(cleared.body.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(cleared.body.overrides).toEqual({ systemPrompt: false, coverLetterPrompt: true });
    expect(cleared.body.coverLetterPrompt).toBe('Their letter prompt.');
  });

  it('treats an emptied prompt as a reset, the way a cleared textarea sends it', async () => {
    const admin = await createAdmin();
    const user = await createUser();
    await admin.agent.put(promptsPath(user.id)).send({ systemPrompt: 'Theirs.' }).expect(200);

    const response = await admin.agent.put(promptsPath(user.id)).send({ systemPrompt: '' }).expect(200);
    expect(response.body.overrides.systemPrompt).toBe(false);
    expect(response.body.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('is per profile: one account\'s prompt never shows on another', async () => {
    const admin = await createAdmin();
    const first = await createUser();
    const second = await createUser();
    await admin.agent.put(promptsPath(first.id)).send({ systemPrompt: 'First\'s prompt.' }).expect(200);

    const response = await admin.agent.get(promptsPath(second.id)).expect(200);
    expect(response.body.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(response.body.overrides.systemPrompt).toBe(false);
  });

  it('leaves the deployment\'s own prompt untouched', async () => {
    const admin = await createAdmin();
    const user = await createUser();
    await admin.agent.put(promptsPath(user.id)).send({ systemPrompt: 'Theirs.' }).expect(200);

    const deployment = await admin.agent.get('/api/admin/ai').expect(200);
    expect(deployment.body.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(deployment.body.overrides.systemPrompt).toBe(false);
  });

  it('rejects a prompt that is not a string', async () => {
    const admin = await createAdmin();
    const user = await createUser();
    await admin.agent.put(promptsPath(user.id)).send({ systemPrompt: 42 }).expect(400);
  });

  it('404s an account that does not exist', async () => {
    const admin = await createAdmin();
    await admin.agent
      .put(promptsPath('00000000-0000-4000-8000-000000000000'))
      .send({ systemPrompt: 'x' })
      .expect(404);
  });
});

describe('what generation reads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the profile\'s prompt over the deployment\'s, per prompt', async () => {
    const admin = await createAdmin();
    const user = await createUser();
    await admin.agent
      .put('/api/admin/ai')
      .send({ systemPrompt: 'Deployment Resume.', coverLetterPrompt: 'Deployment letter.' })
      .expect(200);
    await admin.agent.put(promptsPath(user.id)).send({ coverLetterPrompt: 'Their letter.' }).expect(200);

    // The Resume's falls through to the deployment; the letter's is the profile's.
    await expect(aiConfig.resolveSystemPrompt(user.id)).resolves.toBe('Deployment Resume.');
    await expect(aiConfig.resolveCoverLetterPrompt(user.id)).resolves.toBe('Their letter.');
    // Another account is unaffected, and no account at all means the deployment's.
    await expect(aiConfig.resolveCoverLetterPrompt(admin.id)).resolves.toBe('Deployment letter.');
    await expect(aiConfig.resolveCoverLetterPrompt()).resolves.toBe('Deployment letter.');
  });

  it('hands the profile\'s prompt to the platform — the candidate\'s own, or the one an admin names', async () => {
    const admin = await createAdmin();
    const user = await createUser();
    await admin.agent.put(promptsPath(user.id)).send({ systemPrompt: 'Candidate voice.' }).expect(200);

    vi.spyOn(aiConfig, 'resolveAiConfig').mockResolvedValue({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 110_000,
    });
    const systems: string[] = [];
    vi.spyOn(providers, 'loadProvider').mockResolvedValue({
      generate: async (_config, req) => {
        systems.push(req.system);
        return PAYLOAD;
      },
      chat: async function* () {},
      listModels: async () => [],
    });

    const body = { company: 'Acme', role: 'Engineer', jobDescription: 'We are hiring.' };

    // The candidate generating for themselves gets what the admin set for them…
    await user.agent.post('/api/resume/generate').send(body).expect(200);
    // …an admin generating for the candidate gets the same…
    await admin.agent.post('/api/resume/generate').send({ ...body, userId: user.id }).expect(200);
    // …and for themselves, the deployment's.
    await admin.agent.post('/api/resume/generate').send(body).expect(200);
    // A plain account naming someone else is refused, not quietly given their prompt.
    await user.agent.post('/api/resume/generate').send({ ...body, userId: admin.id }).expect(401);

    expect(systems).toEqual(['Candidate voice.', 'Candidate voice.', DEFAULT_SYSTEM_PROMPT]);
  });
});
