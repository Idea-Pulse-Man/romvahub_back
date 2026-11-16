import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  fingerprintDistance,
  fingerprintImage,
  isSameScreenshot,
  parseFingerprint,
} from '../src/proof/fingerprint.js';

function seeded(seed: number) {
  let state = seed;
  return (n: number) => {
    state = (state * 9301 + 49297) % 233280;
    return Math.floor((state / 233280) * n);
  };
}

function svg(width: number, height: number, ground: string, shapes: string[]): Promise<Buffer> {
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${ground}"/>${shapes.join('')}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}

/**
 * A "thank you for applying" page: white all round, a small logo, a heading, a
 * few lines of grey text and a button, placed by the seed. This is what most
 * confirmation screenshots look like.
 */
function whitePage(seed: number, width = 1440, height = 900): Promise<Buffer> {
  const rnd = seeded(seed);
  const shapes: string[] = [];
  const left = rnd(2) ? width / 2 - 200 - rnd(100) : 80 + rnd(200);
  const hue = rnd(360);
  shapes.push(`<rect x="${left + rnd(40)}" y="${120 + rnd(120)}" width="${90 + rnd(80)}" height="${28 + rnd(20)}" rx="4" fill="hsl(${hue},60%,45%)"/>`);
  let y = 220 + rnd(160);
  shapes.push(`<rect x="${left}" y="${y}" width="${260 + rnd(300)}" height="${22 + rnd(12)}" fill="#1f2937"/>`);
  y += 50 + rnd(30);
  for (let line = 0, lines = 2 + rnd(5); line < lines; line += 1) {
    shapes.push(`<rect x="${left}" y="${y}" width="${300 + rnd(400)}" height="${11 + rnd(4)}" fill="#6b7280"/>`);
    y += 22 + rnd(12);
  }
  shapes.push(`<rect x="${left}" y="${y + 20 + rnd(30)}" width="${120 + rnd(100)}" height="${38 + rnd(10)}" rx="6" fill="hsl(${(hue + rnd(60)) % 360},65%,50%)"/>`);
  return svg(width, height, '#fff', shapes);
}

/** A page built on a board's template: a coloured header bar, a heading, a table of details. */
function boardPage({
  hue = 210,
  heading = 620,
  ground = '#ffffff',
}: { hue?: number; heading?: number; ground?: string } = {}): Promise<Buffer> {
  const shapes = [
    `<rect width="1440" height="56" fill="hsl(${hue},45%,32%)"/>`,
    `<rect x="24" y="24" width="380" height="16" fill="#ffffff" opacity="0.9" transform="translate(0,-6)"/>`,
    `<rect x="24" y="96" width="1392" height="52" fill="#edf7ed"/>`,
    `<rect x="44" y="112" width="420" height="16" fill="#2e7d32"/>`,
    // The one line that a different job changes: the role, in the page's heading.
    `<rect x="24" y="180" width="${heading}" height="30" fill="#191919"/>`,
  ];
  let y = 250;
  for (let line = 0; line < 4; line += 1) {
    shapes.push(`<rect x="24" y="${y}" width="150" height="14" fill="#767676"/>`);
    shapes.push(`<rect x="240" y="${y}" width="${220 + line * 30}" height="14" fill="#444444"/>`);
    y += 34;
  }
  shapes.push(`<rect x="24" y="${y + 24}" width="190" height="40" rx="4" fill="hsl(${hue},60%,45%)"/>`);
  return svg(1440, 900, ground, shapes);
}

/** The ways one screenshot comes back as a different file, with nothing done to the picture. */
async function samePicture(original: Buffer): Promise<Record<string, Buffer>> {
  const { width, height } = await sharp(original).metadata();
  return {
    pngResave: await sharp(original).png({ compressionLevel: 1 }).toBuffer(),
    metadata: await sharp(original).withMetadata({ density: 300 }).withExifMerge({ IFD0: { ImageDescription: 'other' } }).png().toBuffer(),
    losslessWebp: await sharp(original).webp({ lossless: true }).toBuffer(),
    extraMargin: await sharp(original).extend({ top: 60, bottom: 90, left: 40, right: 40, background: '#fff' }).png().toBuffer(),
    croppedMargin: await sharp(original).extract({ left: 20, top: 20, width: width! - 60, height: height! - 50 }).png().toBuffer(),
    chromeTrimmed: await sharp(original).extract({ left: 0, top: 0, width: width!, height: height! - 120 }).png().toBuffer(),
  };
}

/** The ways an encoder changes the pixels without changing the picture. */
async function reEncoded(original: Buffer): Promise<Record<string, Buffer>> {
  return {
    jpegQuality95: await sharp(original).jpeg({ quality: 95 }).toBuffer(),
    jpegQuality40: await sharp(original).jpeg({ quality: 40 }).toBuffer(),
    webpQuality50: await sharp(original).webp({ quality: 50 }).toBuffer(),
    gif: await sharp(original).gif().toBuffer(),
  };
}

async function expectAllDifferent(pages: Buffer[]) {
  const fingerprints = await Promise.all(pages.map((image) => fingerprintImage(image)));
  for (let i = 0; i < fingerprints.length; i += 1) {
    for (let j = i + 1; j < fingerprints.length; j += 1) {
      const distance = fingerprintDistance(fingerprints[i]!, fingerprints[j]!);
      expect(isSameScreenshot(distance), `${i} vs ${j}: ${JSON.stringify(distance)}`).toBe(false);
    }
  }
}

describe('proof fingerprints', () => {
  it('describes an image by its pixels, in a fixed shape', async () => {
    const fingerprint = await fingerprintImage(await whitePage(1));

    expect(fingerprint.v).toBe(3);
    expect(fingerprint.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(fingerprint.rgb, 'base64')).toHaveLength(32 * 32 * 3);
    expect(fingerprint.aspect).toBeGreaterThan(0);
    expect(parseFingerprint(fingerprint)).toEqual(fingerprint);
    expect(parseFingerprint(JSON.parse(JSON.stringify(fingerprint)))).toEqual(fingerprint);
  });

  it('is the same fingerprint for the same file, and no distance at all', async () => {
    const image = await whitePage(2);
    const a = await fingerprintImage(image);
    const b = await fingerprintImage(Buffer.from(image));

    expect(a).toEqual(b);
    expect(fingerprintDistance(a, b)).toEqual({ identical: true, difference: 0, shape: 0 });
  });

  it('knows the same picture by its hash through a re-save, a rename, more margin or less', async () => {
    for (const seed of [3, 4]) {
      const original = await whitePage(seed);
      const fingerprint = await fingerprintImage(original);
      for (const [name, copy] of Object.entries(await samePicture(original))) {
        const other = await fingerprintImage(copy);
        expect(copy.equals(original), `${name} is a different file`).toBe(false);
        expect(other.sha, `${name}: ${JSON.stringify(fingerprintDistance(fingerprint, other))}`).toBe(fingerprint.sha);
        expect(isSameScreenshot(fingerprintDistance(fingerprint, other))).toBe(true);
      }
    }
  });

  it('knows the same picture through a lossy encoder, where the hash cannot', async () => {
    for (const page of [await whitePage(5), await boardPage()]) {
      const fingerprint = await fingerprintImage(page);
      for (const [name, copy] of Object.entries(await reEncoded(page))) {
        const distance = fingerprintDistance(fingerprint, await fingerprintImage(copy));
        expect(isSameScreenshot(distance), `${name}: ${JSON.stringify(distance)}`).toBe(true);
      }
      // A JPEG really has changed the pixels: it is the colour grid, not the
      // hash, that recognises it. (A GIF of a page drawn in a handful of flat
      // colours loses nothing, and its hash still matches.)
      const jpeg = await fingerprintImage(await sharp(page).jpeg({ quality: 40 }).toBuffer());
      expect(jpeg.sha).not.toBe(fingerprint.sha);
      expect(fingerprintDistance(fingerprint, jpeg).difference).toBeGreaterThan(0);
    }
  });

  it('draws a transparent screenshot on white before looking at it', async () => {
    const block = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#2244aa' } }).png().toBuffer();
    const opaque = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ffffff' } })
      .composite([{ input: block, left: 20, top: 20 }])
      .png()
      .toBuffer();
    const transparent = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: block, left: 20, top: 20 }])
      .png()
      .toBuffer();

    expect((await fingerprintImage(transparent)).sha).toBe((await fingerprintImage(opaque)).sha);
  });

  it('does not take two different mostly-white pages for one another', async () => {
    // The shape of the bug this replaced: pages that are all white but for a
    // little text agreed almost everywhere under a gradient hash, and again
    // under a correlation of thumbnails.
    await expectAllDifferent(await Promise.all([10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((seed) => whitePage(seed))));
  });

  it('does not take one board template filled in twice for one screenshot', async () => {
    // The pair a similarity score cannot survive: one employer's confirmation
    // page and another's, differing by the heading, the ground and the brand
    // colour — less, in pixels, than a lossy encoder changes.
    await expectAllDifferent([
      await boardPage(),
      await boardPage({ heading: 520 }),
      await boardPage({ hue: 250 }),
      await boardPage({ hue: 20, heading: 700, ground: '#f7f7f7' }),
    ]);
  });

  it('leaves the same page for a shorter job title looking different', async () => {
    // A heading two words shorter is a handful of cells of the grid, and every
    // one of them goes from black to white: small on the page, unmistakable
    // here. This is the pair the check exists to keep apart.
    const distance = fingerprintDistance(
      await fingerprintImage(await boardPage({ heading: 620 })),
      await fingerprintImage(await boardPage({ heading: 560 })),
    );
    expect(isSameScreenshot(distance)).toBe(false);
    expect(distance.difference).toBeGreaterThan(0.1);
  });

  it('copes with a page that is white all over', async () => {
    const blank = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const fingerprint = await fingerprintImage(blank);
    expect(parseFingerprint(fingerprint)).toEqual(fingerprint);
    expect(isSameScreenshot(fingerprintDistance(fingerprint, await fingerprintImage(blank)))).toBe(true);
    expect(isSameScreenshot(fingerprintDistance(fingerprint, await fingerprintImage(await whitePage(31))))).toBe(false);
  });

  it('refuses bytes that are not an image', async () => {
    await expect(fingerprintImage(Buffer.from('89504e470d0a1a0a', 'hex'))).rejects.toThrow();
    await expect(fingerprintImage(Buffer.from('not a picture'))).rejects.toThrow();
  });

  it('ignores a stored value that is not a fingerprint of this version', () => {
    const rgb = Buffer.alloc(32 * 32 * 3).toString('base64');
    const sha = 'a'.repeat(64);
    expect(parseFingerprint(null)).toBeNull();
    // The first version: a 16×16 thumbnail and a gradient hash.
    expect(parseFingerprint({ v: 1, rgb: Buffer.alloc(768).toString('base64'), hash: 'f'.repeat(96) })).toBeNull();
    // The second: a 32×32 thumbnail compared by correlation, with no hash.
    expect(parseFingerprint({ v: 2, rgb, aspect: 1.6 })).toBeNull();
    expect(parseFingerprint({ v: 3, rgb, aspect: 1.6 })).toBeNull();
    expect(parseFingerprint({ v: 3, sha: 'not a hash', rgb, aspect: 1.6 })).toBeNull();
    expect(parseFingerprint({ v: 3, sha, rgb: 'AAAA', aspect: 1.6 })).toBeNull();
    expect(parseFingerprint({ v: 3, sha, rgb, aspect: 0 })).toBeNull();
    expect(parseFingerprint({ v: 3, sha, rgb, aspect: 1.6 })).toEqual({ v: 3, sha, rgb, aspect: 1.6 });
  });
});
