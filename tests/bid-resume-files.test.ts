import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBid, createUser } from './helpers.js';

/**
 * The Resume files synced up from the desktop Resume Builder's folder:
 * `POST /api/bids/:id/resume-files` stores them, `GET /api/bids/:id/resume`
 * serves them in preference to a generated document.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PDF_V2 = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
// A .docx is a zip; an empty archive's end-of-central-directory record is enough.
const DOCX = Buffer.concat([Buffer.from('PK\u0005\u0006'), Buffer.alloc(18)]);

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('synced Resume files', () => {
  it('stores the PDF and Word files, reports them on the bid, and serves them back', async () => {
    const user = await createUser();
    const bid = await createBid(user);
    expect(bid.hasResume).toBeUndefined();

    const uploaded = await user.agent
      .post(`/api/bids/${bid.id}/resume-files`)
      .attach('pdf', PDF, { filename: 'Will_Kolega_Acme_resume.pdf', contentType: 'application/pdf' })
      .attach('docx', DOCX, { filename: 'Will_Kolega_Acme_resume.docx', contentType: 'application/octet-stream' })
      .expect(200);

    expect(uploaded.body.hasResume).toBe(true);
    expect(uploaded.body.resumeFiles).toMatchObject({
      pdf: { name: 'Will_Kolega_Acme_resume.pdf', size: PDF.byteLength, sha256: sha256(PDF) },
      docx: { name: 'Will_Kolega_Acme_resume.docx', size: DOCX.byteLength, sha256: sha256(DOCX) },
    });
    expect(typeof uploaded.body.resumeFingerprint).toBe('string');

    // The list carries the same flags, so the table can show "View".
    const list = await user.agent.get('/api/bids').expect(200);
    expect(list.body[0].resumeFiles.pdf.sha256).toBe(sha256(PDF));

    const pdf = await user.agent.get(`/api/bids/${bid.id}/resume?format=pdf`).buffer().parse(binary as never).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('Will_Kolega_Acme_resume.pdf');
    expect(Buffer.from(pdf.body).equals(PDF)).toBe(true);

    const docx = await user.agent.get(`/api/bids/${bid.id}/resume?format=docx`).buffer().parse(binary as never).expect(200);
    expect(docx.headers['content-type']).toContain('wordprocessingml');
    expect(Buffer.from(docx.body).equals(DOCX)).toBe(true);
  });

  it('replaces a file of the same format in place and moves the fingerprint', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    const first = await user.agent
      .post(`/api/bids/${bid.id}/resume-files`)
      .attach('pdf', PDF, { filename: 'v1.pdf', contentType: 'application/pdf' })
      .expect(200);
    const second = await user.agent
      .post(`/api/bids/${bid.id}/resume-files`)
      .attach('pdf', PDF_V2, { filename: 'v2.pdf', contentType: 'application/pdf' })
      .expect(200);

    expect(second.body.resumeFiles.pdf).toMatchObject({ name: 'v2.pdf', sha256: sha256(PDF_V2) });
    expect(second.body.resumeFiles.docx).toBeUndefined();
    expect(second.body.resumeFingerprint).not.toBe(first.body.resumeFingerprint);

    // Only the PDF was synced: asking for Word is a 404 that says so.
    const missing = await user.agent.get(`/api/bids/${bid.id}/resume?format=docx`).expect(404);
    expect(missing.body.error.message).toMatch(/Word file/);
  });

  it('refuses bytes that are not what the field claims, and an empty upload', async () => {
    const user = await createUser();
    const bid = await createBid(user);

    await user.agent
      .post(`/api/bids/${bid.id}/resume-files`)
      .attach('pdf', Buffer.from('hello'), { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(400);
    await user.agent
      .post(`/api/bids/${bid.id}/resume-files`)
      .attach('docx', PDF, { filename: 'x.docx', contentType: 'application/octet-stream' })
      .expect(400);
    await user.agent.post(`/api/bids/${bid.id}/resume-files`).expect(400);
  });

  it('removes the synced files, leaving the application without a Resume', async () => {
    const user = await createUser();
    const bid = await createBid(user);
    await user.agent
      .post(`/api/bids/${bid.id}/resume-files`)
      .attach('pdf', PDF, { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(200);

    const removed = await user.agent.delete(`/api/bids/${bid.id}/resume-files`).expect(200);
    expect(removed.body.hasResume).toBeUndefined();
    expect(removed.body.resumeFiles).toBeUndefined();
    await user.agent.get(`/api/bids/${bid.id}/resume?format=pdf`).expect(404);
  });

  it("is scoped: another account cannot see, replace or remove a bid's files", async () => {
    const owner = await createUser();
    const other = await createUser();
    const bid = await createBid(owner);
    await owner.agent
      .post(`/api/bids/${bid.id}/resume-files`)
      .attach('pdf', PDF, { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(200);

    await other.agent.get(`/api/bids/${bid.id}/resume?format=pdf`).expect(404);
    await other.agent
      .post(`/api/bids/${bid.id}/resume-files`)
      .attach('pdf', PDF_V2, { filename: 'y.pdf', contentType: 'application/pdf' })
      .expect(404);
    await other.agent.delete(`/api/bids/${bid.id}/resume-files`).expect(404);

    const still = await owner.agent.get(`/api/bids/${bid.id}`).expect(200);
    expect(still.body.resumeFiles.pdf.sha256).toBe(sha256(PDF));
  });
});

/** supertest's parser for a binary body. */
function binary(res: NodeJS.ReadableStream, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}
