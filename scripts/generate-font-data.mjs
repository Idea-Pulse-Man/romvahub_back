/**
 * Writes `src/resume/template/font-data.ts` from the installed Carlito faces.
 *
 * The Resume PDF used to read these files at runtime with `require.resolve`.
 * That works locally and fails on Vercel: the bundler traces `import`s to
 * decide what to ship, and a resolve call for a `.woff2` is not something it can
 * follow — so the function deployed without the fonts and every render threw
 * MODULE_NOT_FOUND.
 *
 * Embedding them in a module makes the fonts part of the code, which the tracer
 * cannot miss. Run after changing the @fontsource/carlito dependency; the test
 * in tests/resume.test.ts fails if the committed file has drifted from it.
 *
 *   node scripts/generate-font-data.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** All four faces, including bold-italic the template does not currently use:
 *  a missing face is synthesised by the renderer, which is a subtle way for a
 *  later edit to change the document without anyone touching the template. */
const FACES = [
  ['regular', 400, 'normal', 'carlito-latin-400-normal.woff2'],
  ['bold', 700, 'normal', 'carlito-latin-700-normal.woff2'],
  ['italic', 400, 'italic', 'carlito-latin-400-italic.woff2'],
  ['boldItalic', 700, 'italic', 'carlito-latin-700-italic.woff2'],
];

export function buildFontDataSource() {
  const entries = FACES.map(([key, weight, style, file]) => {
    const path = require.resolve(`@fontsource/carlito/files/${file}`);
    const base64 = readFileSync(path).toString('base64');
    return `  {\n    key: '${key}',\n    weight: ${weight},\n    style: '${style}',\n    base64:\n      '${base64}',\n  },`;
  });

  return `/**
 * Carlito, base64-encoded — GENERATED, do not edit.
 *
 * Regenerate with \`node scripts/generate-font-data.mjs\` after changing the
 * @fontsource/carlito dependency. A test asserts this file still matches it.
 *
 * The fonts live in the code rather than beside it because the Resume renderer
 * runs in a traced serverless bundle: an \`import\` is followed, a runtime
 * \`require.resolve\` of a .woff2 is not, and the difference was a production
 * MODULE_NOT_FOUND on every render.
 */

export interface CarlitoFace {
  key: string;
  weight: 400 | 700;
  style: 'normal' | 'italic';
  /** The .woff2 file, base64-encoded, ready for a data: URI. */
  base64: string;
}

export const CARLITO_FACES: CarlitoFace[] = [
${entries.join('\n')}
];
`;
}

const out = join(here, '..', 'src', 'resume', 'template', 'font-data.ts');
writeFileSync(out, buildFontDataSource());
console.log('wrote', out, (buildFontDataSource().length / 1024).toFixed(0) + ' KB');
