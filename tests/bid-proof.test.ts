import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { createAdmin, createBid, createUser } from './helpers.js';
import * as storage from '../src/storage/s3.client.js';
import { prisma } from '../src/prisma.js';

/**
 * The proof screenshot on an application. No bucket is reached: what is
 * worth asserting is everything around it — who may write it, who may remove
 * it, that the old object is let go of when a new one lands, that the signed
 * link travels on the bid every screen reads, and that the same picture
 * uploaded twice is noticed.
 */

/**
 * A real image, because the upload is decoded to compare its pixels. A white
 * page with a coloured bar and a block placed by `seed`, so two seeds are two
 * different pages.
 */
async function screenshot(seed: number): Promise<Buffer> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<rect width="640" height="48" fill="hsl(${(seed * 97) % 360},70%,45%)"/>` +
    `<rect x="${40 + (seed * 53) % 300}" y="${100 + (seed * 31) % 200}" width="220" height="60" fill="#333"/>` +
    `<rect x="60" y="${300 + (seed * 7) % 60}" width="${120 + (seed * 17) % 200}" height="20" fill="#888"/>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

let PNG: Buffer;
beforeAll(async () => {
  PNG = await screenshot(1);
});

/** A bucket that remembers what it was asked to store and to forget. */
function fakeBucket() {
  const stored: string[] = [];
  const deleted: string[] = [];
  let n = 0;

  vi.spyOn(storage, 'uploadProof').mockImplementation(async (bidId) => {
    const key = `proofs/${bidId}/${++n}.png`;
    stored.push(key);
    return { key, url: `https://bucket.test/${key}` };
  });
  vi.spyOn(storage, 'signPhotoUrl').mockImplementation(async (key) =>
    key ? `https://bucket.test/${key}?signed` : undefined,
  );
  vi.spyOn(storage, 'deletePhoto').mockImplementation(async (key) => {
    if (key) deleted.push(key);
  });

  return { stored, deleted };
}

describe('POST /api/bids/:id/proof', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores the screenshot and hands back the bid with a signed link', async () => {
    const bucket = fakeBucket();
    const user = await createUser();
    const bid = await createBid(user);

    const response = await user.agent
      .post(`/api/bids/${bid.id}/proof`)
      .attach('proof', PNG, { filename: 'thanks.png', contentType: 'image/png' })
      .expect(200);

    expect(response.body.id).toBe(bid.id);
    expect(response.body.proofUrl).toBe(`https://bucket.test/${bucket.stored[0]}?signed`);

    // On the list too — the table shows the link on every row.
    const list = await user.agent.get('/api/bids').expect(200);
    expect(list.body[0].proofUrl).toBe(response.body.proofUrl);
  });

  it('replaces an earlier screenshot and lets go of the old object', async () => {
    const bucket = fakeBucket();
    const user = await createUser();
    const bid = await createBid(user);

    await user.agent
      .post(`/api/bids/${bid.id}/proof`)
      .attach('proof', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(200);
    const second = await user.agent
      .post(`/api/bids/${bid.id}/proof`)
      .attach('proof', PNG, { filename: 'b.png', contentType: 'image/png' })
      .expect(200);

    expect(second.body.proofUrl).toContain(bucket.stored[1]);
    expect(bucket.deleted).toEqual([bucket.stored[0]]);
  });

  it('rejects a file that is not an image, and a request with no file', async () => {
    fakeBucket();
    const user = await createUser();
    const bid = await createBid(user);

    await user.agent
      .post(`/api/bids/${bid.id}/proof`)
      .attach('proof', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(400);
    await user.agent.post(`/api/bids/${bid.id}/proof`).expect(400);
  });

  it('refuses a file that is not decodable as an image, before the bucket is touched', async () => {
    const bucket = fakeBucket();
    const user = await createUser();
    const bid = await createBid(user);

    const response = await user.agent
      .post(`/api/bids/${bid.id}/proof`)
      .attach('proof', Buffer.from('89504e470d0a1a0a', 'hex'), { filename: 'broken.png', contentType: 'image/png' })
      .expect(400);

    expect(response.body.error.message).toMatch(/could not be read as an image/i);
    expect(bucket.stored).toEqual([]);
  });

  it("hides another user's bid behind a 404", async () => {
    fakeBucket();
    const owner = await createUser();
    const other = await createUser();
    const bid = await createBid(owner);

    await other.agent
      .post(`/api/bids/${bid.id}/proof`)
      .attach('proof', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(404);
  });

  it('lets an admin attach one to any bid', async () => {
    fakeBucket();
    const owner = await createUser();
    const admin = await createAdmin();
    const bid = await createBid(owner);

    const response = await admin.agent
      .post(`/api/bids/${bid.id}/proof`)
      .attach('proof', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(200);
    expect(response.body.proofUrl).toBeDefined();
  });

  it('answers 503 when no bucket is configured', async () => {
    // No fake bucket: the test environment has no storage variables set.
    const user = await createUser();
    const bid = await createBid(user);

    await user.agent
      .post(`/api/bids/${bid.id}/proof`)
      .attach('proof', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(503);
  });
});

describe('the same screenshot twice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function upload(agent: TestAgent, bidId: string, image: Buffer, contentType = 'image/png') {
    return agent.post(`/api/bids/${bidId}/proof`).attach('proof', image, { filename: 'thanks', contentType });
  }

  it('is refused under one profile, by the picture rather than the file, and nothing is stored', async () => {
    const bucket = fakeBucket();
    const user = await createUser();
    const first = await createBid(user, { company: 'Acme' });
    const second = await createBid(user, { company: 'Acme again' });
    const page = await screenshot(2);

    await upload(user.agent, first.id, page).expect(200);

    // Re-saved as a JPEG: a different file, byte for byte, and the same picture.
    const resaved = await sharp(page).jpeg({ quality: 50 }).toBuffer();
    expect(resaved.equals(page)).toBe(false);
    const refused = await upload(user.agent, second.id, resaved, 'image/jpeg').expect(409);

    expect(refused.body.error.code).toBe('DUPLICATE_PROOF');
    expect(refused.body.error.message).toMatch(/already on another of your applications/i);
    const [match] = refused.body.error.data.matches;
    expect(match.bid.id).toBe(first.id);
    expect(match.bid.company).toBe('Acme');
    // The encoder moved every pixel a little, so it was the colour grid that
    // recognised this one and not the hash.
    expect(match.match.identical).toBe(false);
    expect(match.match.difference).toBeLessThan(0.045);

    // The second application is as it was: no screenshot, and the bucket saw one upload.
    expect(bucket.stored).toHaveLength(1);
    const list = await user.agent.get('/api/bids').expect(200);
    expect(list.body.find((b: { id: string }) => b.id === second.id).proofUrl).toBeUndefined();
  });

  it('is not raised by a different page', async () => {
    fakeBucket();
    const user = await createUser();
    const first = await createBid(user);
    const second = await createBid(user);

    await upload(user.agent, first.id, await screenshot(3)).expect(200);
    await upload(user.agent, second.id, await screenshot(4)).expect(200);
  });

  it('lets an application replace its own screenshot with the same page', async () => {
    fakeBucket();
    const user = await createUser();
    const bid = await createBid(user);
    const page = await screenshot(15);

    await upload(user.agent, bid.id, page).expect(200);
    await upload(user.agent, bid.id, await sharp(page).jpeg({ quality: 60 }).toBuffer(), 'image/jpeg').expect(200);
  });

  it("is only ever the same profile's screenshots that are compared", async () => {
    fakeBucket();
    const alice = await createUser();
    const bob = await createUser();
    const admin = await createAdmin();
    const alices = await createBid(alice, { company: 'Globex' });
    const bobs = await createBid(bob, { company: 'Globex' });
    const page = await screenshot(5);

    await upload(alice.agent, alices.id, page).expect(200);
    // The same page under another profile is not Bob's concern, nor Alice's.
    await upload(bob.agent, bobs.id, await sharp(page).webp({ quality: 60 }).toBuffer(), 'image/webp').expect(200);
    expect((await admin.agent.get(`/api/bids/${bobs.id}/proof/matches`).expect(200)).body).toEqual([]);
    expect((await alice.agent.get(`/api/bids/${alices.id}/proof/matches`).expect(200)).body).toEqual([]);
  });

  it("compares an admin's upload with the chosen candidate's screenshots, not the admin's own", async () => {
    fakeBucket();
    const admin = await createAdmin();
    const carol = await createUser();
    const page = await screenshot(8);
    const carolsFirst = await createBid(carol, { company: 'Initech' });
    const carolsSecond = await createBid(admin, { company: 'Initech again', userId: carol.id });
    const admins = await createBid(admin, { company: 'Admin own' });

    await upload(carol.agent, carolsFirst.id, page).expect(200);
    await upload(admin.agent, admins.id, page).expect(200);

    const refused = await upload(admin.agent, carolsSecond.id, page).expect(409);
    expect(refused.body.error.data.matches.map((m: { bid: { id: string } }) => m.bid.id)).toEqual([carolsFirst.id]);
    expect(refused.body.error.data.matches[0].bid.candidate.userId).toBe(carol.id);
  });

  it('shows, and lets an admin clear, a pair the rule could not prevent', async () => {
    fakeBucket();
    const admin = await createAdmin();
    const first = await createBid(admin);
    const second = await createBid(admin);
    await upload(admin.agent, first.id, await screenshot(6)).expect(200);

    // A screenshot from before the rule, fingerprinted by the backfill: the
    // same picture on a second application, which no upload can make now.
    const stored = await prisma.bid.findUniqueOrThrow({ where: { id: first.id }, select: { proofFingerprint: true } });
    await prisma.bid.update({
      where: { id: second.id },
      data: { proofKey: 'proofs/legacy.png', proofFingerprint: stored.proofFingerprint as object },
    });
    expect((await admin.agent.get(`/api/bids/${first.id}/proof/matches`).expect(200)).body.map((m: { bid: { id: string } }) => m.bid.id)).toEqual([second.id]);

    // Replaced with a different page, the pair is gone; removed, likewise.
    await upload(admin.agent, second.id, await screenshot(7)).expect(200);
    expect((await admin.agent.get(`/api/bids/${first.id}/proof/matches`).expect(200)).body).toEqual([]);
    await admin.agent.delete(`/api/bids/${second.id}/proof`).expect(200);
    expect((await admin.agent.get(`/api/bids/${first.id}/proof/matches`).expect(200)).body).toEqual([]);
  });

  it('has no matches for an application without a screenshot', async () => {
    fakeBucket();
    const user = await createUser();
    const bid = await createBid(user);

    expect((await user.agent.get(`/api/bids/${bid.id}/proof/matches`).expect(200)).body).toEqual([]);
  });
});

describe('POST /api/bids/proof/check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function check(agent: TestAgent, image: Buffer, fields: Record<string, string> = {}, contentType = 'image/png') {
    let req = agent.post('/api/bids/proof/check');
    for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
    return req.attach('proof', image, { filename: 'picked', contentType });
  }

  it('answers the matches the upload would refuse for, without storing anything', async () => {
    const bucket = fakeBucket();
    const user = await createUser();
    const filed = await createBid(user, { company: 'Acme' });
    const page = await screenshot(11);
    await user.agent.post(`/api/bids/${filed.id}/proof`).attach('proof', page, { filename: 'a', contentType: 'image/png' }).expect(200);

    const same = await check(user.agent, await sharp(page).jpeg({ quality: 50 }).toBuffer(), {}, 'image/jpeg').expect(200);
    expect(same.body.map((m: { bid: { id: string } }) => m.bid.id)).toEqual([filed.id]);

    const other = await check(user.agent, await screenshot(12)).expect(200);
    expect(other.body).toEqual([]);

    // One upload, no more: the checks wrote nothing.
    expect(bucket.stored).toHaveLength(1);
    expect(await prisma.bid.count()).toBe(1);
  });

  it('leaves the application being edited out of the comparison', async () => {
    fakeBucket();
    const user = await createUser();
    const editing = await createBid(user);
    const another = await createBid(user);
    const page = await screenshot(13);
    await user.agent.post(`/api/bids/${editing.id}/proof`).attach('proof', page, { filename: 'a', contentType: 'image/png' }).expect(200);

    // Re-picking the page the application already has is not a duplicate of anything.
    expect((await check(user.agent, page, { bidId: editing.id }).expect(200)).body).toEqual([]);
    // Without saying which application is being edited, its own screenshot is a match.
    expect((await check(user.agent, page).expect(200)).body.map((m: { bid: { id: string } }) => m.bid.id)).toEqual([editing.id]);

    // A pair from before the rule: the same picture on `another`, seeded as the backfill would.
    const stored = await prisma.bid.findUniqueOrThrow({ where: { id: editing.id }, select: { proofFingerprint: true } });
    await prisma.bid.update({ where: { id: another.id }, data: { proofKey: 'proofs/legacy.png', proofFingerprint: stored.proofFingerprint as object } });
    const matches = await check(user.agent, page, { bidId: editing.id }).expect(200);
    expect(matches.body.map((m: { bid: { id: string } }) => m.bid.id)).toEqual([another.id]);
  });

  it("compares an admin's pick with the chosen candidate's screenshots, and a plain account's only with its own", async () => {
    fakeBucket();
    const admin = await createAdmin();
    const carol = await createUser();
    const dave = await createUser();
    const page = await screenshot(14);
    const carols = await createBid(carol);
    await carol.agent.post(`/api/bids/${carols.id}/proof`).attach('proof', page, { filename: 'a', contentType: 'image/png' }).expect(200);

    const forCarol = await check(admin.agent, page, { userId: carol.id }).expect(200);
    expect(forCarol.body.map((m: { bid: { id: string } }) => m.bid.id)).toEqual([carols.id]);
    expect((await check(admin.agent, page).expect(200)).body).toEqual([]);

    // Dave cannot ask about Carol's screenshots by naming her.
    expect((await check(dave.agent, page, { userId: carol.id }).expect(200)).body).toEqual([]);
  });

  it('refuses what is not a decodable image, and a bid that is not the caller\'s', async () => {
    fakeBucket();
    const user = await createUser();
    const other = await createUser();
    const others = await createBid(other);

    await check(user.agent, Buffer.from('89504e470d0a1a0a', 'hex')).expect(400);
    await check(user.agent, PNG, { bidId: others.id }).expect(404);
    await user.agent.post('/api/bids/proof/check').expect(400);
  });
});

describe('DELETE /api/bids/:id/proof', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets a user remove proof from an accessible application', async () => {
    const bucket = fakeBucket();
    const user = await createUser();
    const bid = await createBid(user);
    await user.agent
      .post(`/api/bids/${bid.id}/proof`)
      .attach('proof', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(200);

    const removed = await user.agent.delete(`/api/bids/${bid.id}/proof`).expect(200);
    expect(removed.body.proofUrl).toBeUndefined();
    expect(bucket.deleted).toEqual([bucket.stored[0]]);
  });

  it('goes with the bid when the bid is deleted, singly or in bulk', async () => {
    const bucket = fakeBucket();
    const admin = await createAdmin();
    const one = await createBid(admin);
    const two = await createBid(admin);
    // Two different pages: the same one twice would be refused.
    for (const [bid, image] of [[one, PNG], [two, await screenshot(9)]] as const) {
      await admin.agent
        .post(`/api/bids/${bid.id}/proof`)
        .attach('proof', image, { filename: 'a.png', contentType: 'image/png' })
        .expect(200);
    }

    await admin.agent.delete(`/api/bids/${one.id}`).expect(204);
    await admin.agent.post('/api/bids/bulk/delete').send({ ids: [two.id] }).expect(200);

    expect(bucket.deleted.sort()).toEqual([...bucket.stored].sort());
  });
});
