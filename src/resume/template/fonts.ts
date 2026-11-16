import { CARLITO_FACES } from './font-data.js';

/**
 * Calibri as `@font-face`, embedded in the HTML.
 *
 * The template is specified in Calibri, which ships with Office and exists on
 * no server. Carlito is metric-compatible with it — same advance widths, same
 * line height — so a page laid out in one is laid out identically in the other.
 *
 * Embedding it rather than relying on a system font is what makes the output
 * deterministic: the desktop app's PDF depends on what is installed on the
 * machine that made it, and this one does not.
 *
 * The bytes come from a generated module rather than from `@fontsource/carlito`
 * at runtime. Reading them with `require.resolve` worked locally and failed in
 * production — a traced serverless bundle ships what it can follow from the
 * imports, and a resolve call for a `.woff2` is not something it can follow, so
 * the function deployed without its fonts. An import is.
 */

function faceCss({ base64, weight, style }: (typeof CARLITO_FACES)[number]): string {
  return `@font-face {
  font-family: 'Calibri';
  font-style: ${style};
  font-weight: ${weight};
  font-display: block;
  src: url(data:font/woff2;base64,${base64}) format('woff2');
}`;
}

/**
 * Joined once. The four faces come to a few hundred kilobytes of CSS, and a
 * warm function should not rebuild that string on every Resume.
 */
let cached: string | undefined;

export function fontFaceCss(): string {
  cached ??= CARLITO_FACES.map(faceCss).join('\n');
  return cached;
}
