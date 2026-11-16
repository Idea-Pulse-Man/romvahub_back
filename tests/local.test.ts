import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, request } from './helpers.js';

/**
 * Opening the Resume save folder in Explorer. Only the refusals are exercised
 * here: the success path opens a real window on the machine running the tests.
 */
describe.runIf(process.platform === 'win32')('POST /api/local/open-folder', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'romva-space-resumes-'));
    await writeFile(
      path.join(root, '.romva-space-sync.json'),
      JSON.stringify({ version: 1, folderId: 'folder-aaaaaaaa', entries: {} }),
    );
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('needs a signed-in user', async () => {
    await request().post('/api/local/open-folder').send({ root }).expect(401);
  });

  it('refuses a page opened from another computer', async () => {
    const user = await createUser();
    const response = await user.agent
      .post('/api/local/open-folder')
      .set('Origin', 'http://192.168.107.13:5173')
      .send({ root })
      .expect(403);
    expect(response.body.error.message).toMatch(/localhost/);
  });

  it('needs a folder id or a path', async () => {
    const user = await createUser();
    await user.agent.post('/api/local/open-folder').send({}).expect(400);
  });

  it('refuses a typed path that is not the save folder', async () => {
    const user = await createUser();
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'not-resumes-'));
    try {
      await user.agent.post('/api/local/open-folder').send({ root: elsewhere }).expect(404);
      // The synced folder of a different save folder (another id) is refused too.
      await user.agent
        .post('/api/local/open-folder')
        .send({ folderId: 'folder-bbbbbbbb', hint: root, root })
        .expect(404);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses a relative path', async () => {
    const user = await createUser();
    await user.agent.post('/api/local/open-folder').send({ root: 'Resumes' }).expect(400);
  });
});
