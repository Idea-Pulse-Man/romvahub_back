import { createHash } from 'node:crypto';
import sharp, { type Region } from 'sharp';

/**
 * Telling one confirmation screenshot from another by what is in the picture.
 *
 * A screenshot uploaded twice is rarely the same file twice: it is saved again
 * from the screenshot tool, given a different name, stripped of its EXIF,
 * re-wrapped as a PNG, padded with white. File names, sizes and checksums all
 * change, and none of them was ever the picture. So the picture is what is
 * compared.
 *
 * **Why this is a hash and not a similarity score.** Two confirmation pages
 * from the same board — "Thank you for applying" for two different jobs — are
 * one template with a line of text and a brand colour changed. On confirmation
 * pages rendered in a browser, the closest such pair differs by 0.059 on the
 * scale below, while the *same* page saved again as a GIF differs by 0.035 and
 * at half size by up to 0.080. The difference between two applications is
 * smaller than the damage an encoder does, so a band wide enough to hold every
 * copy of one page is wide enough to swallow a different application's page —
 * whatever the measure, and both of the ones tried before this (a gradient
 * hash, then a correlation of thumbnails) put different pages inside it, which
 * is what made the check tell a candidate their new screenshot was one they
 * had already filed. A screenshot wrongly called a duplicate is work blocked;
 * a duplicate not spotted is only a warning not shown. So the picture is
 * matched, not scored:
 *
 * - **`sha`** is a SHA-256 of the pixels themselves, once what is not the
 *   picture is normalised away: alpha drawn on white, the colour space fixed,
 *   the white margin trimmed off. Two uploads of one screenshot agree here
 *   whatever container, metadata or padding they arrive in — re-saved as PNG,
 *   as lossless WebP, padded with white, cropped into the margin, with a strip
 *   of browser chrome cut off. Equality of a hash cannot be a false positive:
 *   different pictures do not collide.
 * - **`rgb`**, a 32×32 grid of mean colour taken inside the content frame, is
 *   the narrow allowance on top of it, for the same picture re-encoded by a
 *   lossy encoder, which changes every pixel a little and leaves no two hashes
 *   alike. Two grids are compared cell by cell and the *worst* cell decides,
 *   over a search that lines them up first. Every lossy re-encoding measured —
 *   JPEG at 95, 75 and 40, WebP at 50, GIF — stays at or under 0.035, and the
 *   closest pair of different pages sits at 0.059, so the allowance is 0.045:
 *   half way between. A copy at another size, or padded *and* re-encoded,
 *   lands on both sides of it and is recognised perhaps half the time. That is
 *   the price of a band this narrow, and it is the right way round.
 *
 * The version is stored with the fingerprint so an older shape is told from
 * this one and re-fingerprinted by `yarn proofs:fingerprint` rather than
 * compared.
 */

export const FINGERPRINT_VERSION = 3;

/** The colour grid's side. 32×32×3 = 3072 bytes, 4 KB as base64, on every bid. */
const GRID = 32;
const CHANNELS = 3;

/**
 * How far from white a pixel may be (of 255) and still be margin, when the
 * *hash* is taken. A hairline border or an off-white page ground is margin;
 * the faintest text is not.
 */
const TRIM_THRESHOLD = 24;

/**
 * How far from white, in its strongest channel, a pixel has to be before it
 * counts as ink at all. Above any page ground — a LinkedIn card sits on
 * #f4f2ee — and below the faintest text.
 */
const INK_FLOOR = 24;

/**
 * The share of the ink the frame gives up at each edge. Not a bounding box:
 * where the outermost inked pixel lands is decided by a single antialiased
 * edge, and a JPEG of the same picture moves it. Where the first fifth of a
 * percent of the ink lies is decided by the whole picture, and that does not
 * move — the same frame comes back from JPEG at 40 and from a copy at half
 * size, to four decimal places.
 */
const FRAME_TAIL = 0.002;

/**
 * The frame is found on a copy no wider than this, blurred: both steps average
 * away what an encoder did to single pixels, and neither costs anything on a
 * screenshot the size of a browser window.
 */
const PROBE_WIDTH = 400;
const PROBE_BLUR = 1;

/**
 * Slack in the comparison, in cells. The frame around two copies of one page
 * can land a pixel apart, and a page's own edges are hard: an eightieth of a
 * cell of slide across the foot of a header bar moves that cell as far as a
 * lossy encoder moves anything. So the grids are lined up before they are
 * compared — every offset from a cell out to a cell back, in half cells, with
 * the values between cells interpolated — and the one that fits best decides.
 * The outermost ring is left out of every comparison so each offset is judged
 * on the same cells.
 */
const SEARCH = 1;
const SEARCH_STEP = 0.5;

/**
 * The allowance for the same picture re-encoded. Calibrated on 36 confirmation
 * pages rendered in a browser — a Greenhouse-style thank-you page, a LinkedIn
 * "application sent" card and a Workday submission page, for six employers and
 * six roles — each re-saved as PNG, as lossless WebP, as JPEG at 95, 75 and
 * 40, as WebP at 50 and as GIF, padded with white, cropped, with a strip of
 * browser chrome cut off, and rescaled. All 36 are recognised through every
 * lossy re-encoding, the worst at 0.035. None of the 630 pairs of different
 * pages comes within 0.059 — the closest being one employer's page for two
 * different roles, and after it, at 0.067, one role's page at two employers,
 * where only the name in the header and the header's hue differ.
 *
 * `shape` is all but zero for the same picture, because the frame lands in the
 * same place; it is there to stop two grids of quite different pictures being
 * compared at all.
 */
export const NEAR_DUPLICATE = { difference: 0.045, shape: 0.05 } as const;

export interface ProofFingerprint {
  v: typeof FINGERPRINT_VERSION;
  /** SHA-256, hex, of the RGB bytes of the picture inside its white margin, and its size. */
  sha: string;
  /** 32×32 mean RGB taken inside the content frame, row-major, base64. */
  rgb: string;
  /** Width over height of the content frame. */
  aspect: number;
}

export interface FingerprintDistance {
  /** The same pixels, once margin, container and metadata are set aside. */
  identical: boolean;
  /** The worst single cell of the colour grid: 0 for the same picture, 1 for black against white. */
  difference: number;
  /** How far apart the content frames' aspect ratios are, as a log ratio. */
  shape: number;
}

/** Whatever the decoder hands back — 1, 3 or 4 channels — as three bytes a pixel. */
function toRgb(data: Buffer, channels: number, pixels: number): Buffer {
  if (channels === CHANNELS && data.length === pixels * CHANNELS) return data;
  const rgb = Buffer.alloc(pixels * CHANNELS);
  for (let i = 0; i < pixels; i += 1) {
    const base = i * channels;
    for (let c = 0; c < CHANNELS; c += 1) {
      // A greyscale image decodes to one channel; spread it across three.
      rgb[i * CHANNELS + c] = data[base + (channels >= CHANNELS ? c : 0)] ?? 0;
    }
  }
  return rgb;
}

/** The white margin cut off, exactly, for the hash: two lossless copies stay byte for byte identical. */
async function trimWhiteMargin(image: Buffer): Promise<Buffer> {
  try {
    // A page that is white all over has nothing to trim and is kept whole
    // rather than refused: sharp throws on an image it would trim to nothing.
    return await sharp(image).trim({ background: '#ffffff', threshold: TRIM_THRESHOLD }).png().toBuffer();
  } catch {
    return image;
  }
}

/**
 * The part of one region of the picture holding all but `FRAME_TAIL` of its
 * ink, in the picture's own coordinates. Ink is distance from white, so only
 * white-ish margin is ever given up whatever the page's own ground is: a frame
 * drawn around whatever colour the corner happens to be would cut off a header
 * bar that runs to the edge, and that bar is often the one thing telling two
 * employers' pages apart.
 */
async function inkFrame(image: Buffer, region: Region): Promise<Region> {
  const { data, info } = await sharp(image)
    .extract(region)
    .resize({ width: Math.min(region.width, PROBE_WIDTH), fit: 'inside', withoutEnlargement: true })
    .blur(PROBE_BLUR)
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const probe = toRgb(data, info.channels, info.width * info.height);

  const columns = new Float64Array(info.width);
  const rows = new Float64Array(info.height);
  let total = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const at = (y * info.width + x) * CHANNELS;
      const ink = Math.max(
        0,
        Math.max(255 - (probe[at] ?? 255), 255 - (probe[at + 1] ?? 255), 255 - (probe[at + 2] ?? 255)) - INK_FLOOR,
      );
      columns[x] = (columns[x] ?? 0) + ink;
      rows[y] = (rows[y] ?? 0) + ink;
      total += ink;
    }
  }
  if (total <= 0) return region;

  /**
   * Where `FRAME_TAIL` of the ink has gone by, from each end — carried on past
   * the cell the crossing falls in, to the fraction of it where the crossing
   * actually lies. The probe is a fraction of the picture's width, so without
   * that fraction the frame could only land on every third or fourth pixel,
   * and a copy crossing a cell earlier would jump the whole way.
   */
  const span = (mass: Float64Array): [number, number] => {
    const tail = total * FRAME_TAIL;
    let first = 0;
    let last = mass.length;
    for (let i = 0, sum = 0; i < mass.length; i += 1) {
      const cell = mass[i]!;
      if (sum + cell > tail) { first = i + (cell > 0 ? (tail - sum) / cell : 0); break; }
      sum += cell;
    }
    for (let i = mass.length - 1, sum = 0; i >= 0; i -= 1) {
      const cell = mass[i]!;
      if (sum + cell > tail) { last = i + 1 - (cell > 0 ? (tail - sum) / cell : 0); break; }
      sum += cell;
    }
    return first < last ? [first, last] : [0, mass.length];
  };

  const [firstColumn, lastColumn] = span(columns);
  const [firstRow, lastRow] = span(rows);
  const scaleX = region.width / info.width;
  const scaleY = region.height / info.height;
  const left = region.left + Math.round(firstColumn * scaleX);
  const top = region.top + Math.round(firstRow * scaleY);
  const right = region.left + Math.round(lastColumn * scaleX);
  const bottom = region.top + Math.round(lastRow * scaleY);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : region;
}

/**
 * The frame the grid is measured in, so that the browser window's size, a
 * screenshot tool's padding and a strip of chrome cut off the bottom are no
 * part of the comparison.
 *
 * Sharp's own trim cannot do this job, and nor can a plain bounding box. Both
 * stop at the outermost pixel that is not background, and what a lossy encoder
 * leaves around a card's edge is not background: a LinkedIn confirmation and a
 * JPEG of it trimmed to boxes 40 pixels apart, and even the bounding box of
 * the ink moved far enough to swing a cell of the grid past the whole
 * allowance. Where the ink *mass* lies is a question about the whole picture,
 * and its answer holds still.
 *
 * Asked twice, because the first answer is measured on a grid laid over the
 * whole picture: pad a screenshot with white and that grid falls elsewhere
 * against the content, moving the frame by a pixel or two — which is a tenth
 * of a cell of drift by the far edge, and on a hard edge that is the whole
 * allowance again. The second pass measures inside the first answer, where
 * two copies of one picture are already looking at nearly the same thing, and
 * lands them together.
 */
async function contentFrame(image: Buffer): Promise<Region> {
  const meta = await sharp(image).metadata();
  const whole = { left: 0, top: 0, width: meta.width ?? 1, height: meta.height ?? 1 };
  const rough = await inkFrame(image, whole);
  return inkFrame(image, rough);
}

/**
 * The fingerprint of one screenshot. Throws when the bytes are not an image
 * sharp can decode, which the upload route turns into a 400.
 */
export async function fingerprintImage(image: Buffer): Promise<ProofFingerprint> {
  // Drawn on white as a browser would show it, so a transparent screenshot and
  // the same one on white are one picture.
  const flat = await sharp(image, { pages: 1 })
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .png()
    .toBuffer();

  // The hash: the picture's own bytes, with only its white margin set aside.
  const hashed = await trimWhiteMargin(flat);
  const full = await sharp(hashed).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  const pixels = toRgb(full.data, full.info.channels, full.info.width * full.info.height);

  // The grid: the content frame, which survives a lossy encoder where the trim
  // above does not, averaged down to one colour per cell.
  const box = await contentFrame(flat);
  const grid = await sharp(flat)
    .extract(box)
    // A mean of the pixels under each cell: the same grid whatever the
    // screenshot was scaled to, and free of the ringing a sharper kernel
    // leaves along an edge.
    .resize(GRID, GRID, { fit: 'fill', kernel: 'mitchell' })
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });

  return {
    v: FINGERPRINT_VERSION,
    sha: createHash('sha256').update(`${full.info.width}x${full.info.height}:`).update(pixels).digest('hex'),
    rgb: toRgb(grid.data, grid.info.channels, GRID * GRID).toString('base64'),
    aspect: Math.round((box.width / box.height) * 1000) / 1000,
  };
}

/** A stored fingerprint, or `null` for anything that is not one of this version. */
export function parseFingerprint(value: unknown): ProofFingerprint | null {
  if (!value || typeof value !== 'object') return null;
  const { v, sha, rgb, aspect } = value as Record<string, unknown>;
  if (v !== FINGERPRINT_VERSION || typeof sha !== 'string' || typeof rgb !== 'string' || typeof aspect !== 'number') {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  if (Buffer.from(rgb, 'base64').length !== GRID * GRID * CHANNELS) return null;
  return { v, sha, rgb, aspect };
}

/** One channel of a grid at a point between cells, the four around it mixed by how near each is. */
function sample(grid: Buffer, x: number, y: number, channel: number): number {
  const x0 = Math.max(0, Math.min(GRID - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(GRID - 1, Math.floor(y)));
  const x1 = Math.min(GRID - 1, x0 + 1);
  const y1 = Math.min(GRID - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (cx: number, cy: number) => grid[(cy * GRID + cx) * CHANNELS + channel] ?? 0;
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * The worst cell, for one alignment of the two grids, given up as soon as it
 * is past `ceiling` — the best any other alignment has managed, which most
 * alignments exceed within a few cells.
 */
function worstCell(a: Buffer, b: Buffer, shiftX: number, shiftY: number, ceiling: number): number {
  let worst = 0;
  for (let y = SEARCH; y < GRID - SEARCH; y += 1) {
    for (let x = SEARCH; x < GRID - SEARCH; x += 1) {
      const from = (y * GRID + x) * CHANNELS;
      let sum = 0;
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        sum += Math.abs((a[from + channel] ?? 0) - sample(b, x + shiftX, y + shiftY, channel));
      }
      const difference = sum / (CHANNELS * 255);
      if (difference > worst) {
        worst = difference;
        if (worst >= ceiling) return worst;
      }
    }
  }
  return worst;
}

export function fingerprintDistance(a: ProofFingerprint, b: ProofFingerprint): FingerprintDistance {
  if (a.sha === b.sha) return { identical: true, difference: 0, shape: 0 };

  const gridA = Buffer.from(a.rgb, 'base64');
  const gridB = Buffer.from(b.rgb, 'base64');

  let difference = 1;
  for (let shiftY = -SEARCH; shiftY <= SEARCH; shiftY += SEARCH_STEP) {
    for (let shiftX = -SEARCH; shiftX <= SEARCH; shiftX += SEARCH_STEP) {
      difference = Math.min(difference, worstCell(gridA, gridB, shiftX, shiftY, difference));
    }
  }

  return { identical: false, difference, shape: Math.abs(Math.log(a.aspect / b.aspect)) };
}

export function isSameScreenshot(distance: FingerprintDistance): boolean {
  return (
    distance.identical ||
    (distance.difference <= NEAR_DUPLICATE.difference && distance.shape <= NEAR_DUPLICATE.shape)
  );
}
