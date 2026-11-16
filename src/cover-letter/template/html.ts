import { buildCoverLetterModel, type CoverLetterContext, type CoverLetterModel } from './model.js';
import { fontFaceCss } from '../../resume/template/fonts.js';
import type { Profile } from '../../domain/types.js';
import type { CoverLetterPayload } from '../cover-letter.schemas.js';

/**
 * Renders the cover letter model as a standalone HTML document, which is then
 * turned into a PDF by the same headless Chromium the Resume is printed with.
 *
 * The page is deliberately the Resume's: US Letter, Word's Narrow margins, and
 * Calibri bound to the embedded Carlito so the layout does not depend on the
 * host's fonts. The two documents are sent together and read one after the
 * other, so a letter set in different type on a different page would read as
 * having come from somewhere else.
 *
 * What differs is the typography *inside* that page, because a letter is not a
 * Resume: 11pt rather than 10pt, looser leading, and a blank line between
 * paragraphs instead of the Resume's tight stack of headed sections.
 *
 * The content comes from `model.ts` and is shared with the .docx renderer;
 * everything in this file is presentation. Keep the two in step: a spacing or
 * ordering change here needs the matching change in `docx.ts`.
 */

/** Everything interpolated into the HTML is user-supplied, so escape it all. */
function esc(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Joins already-escaped parts with a " | " separator, dropping empties. */
function pipeJoin(parts: string[]): string {
  return parts.filter(Boolean).join('<span class="sep">|</span>');
}

/* As in the Resume's stylesheet: "space before" is padding-top and "space
   after" is padding-bottom, with every margin left at 0, so that the gaps add
   up the way Word's do rather than collapsing to the larger of the two. */
const STYLES = `
/* The Resume's page, so the two documents in one application match. */
@page {
  size: 8.5in 11in;
  margin: 0.5in;
}

* { box-sizing: border-box; }

html, body { margin: 0; padding: 0; }

body {
  font-family: Calibri, Carlito, "Noto Sans", "Segoe UI", sans-serif;
  /* A point larger than the Resume: a letter is read as prose rather than
     scanned, and it has a page to spare where the Resume has none. */
  font-size: 11pt;
  line-height: 1.4;
  color: #1a1a1a;
  -webkit-font-smoothing: antialiased;
}

p { margin: 0; }

/* ---------- Header ---------- */
/* The Resume's header, at the Resume's sizes, so the two pages open the same. */
.name {
  font-size: 20pt;
  font-weight: bold;
  padding: 0 0 3pt;
}
.personal { padding: 0 0 5pt; }
.sep {
  font-weight: normal;
  padding: 0 4.5pt;
}

/* The rule under the header is what separates the letterhead from the letter. */
.rule {
  border-bottom: 0.75pt solid #888888;
  padding-bottom: 1.5pt;
}

.date { padding: 14pt 0 0; }
.recipient { padding: 14pt 0 0; }
.greeting { padding: 14pt 0 0; }

/* ---------- Body ---------- */
/* The blank line between paragraphs is the block-letter convention: no first
   line indent, one clear line of space instead. */
.body-paragraph {
  padding: 11pt 0 0;
  text-align: left;
}
/* A paragraph never splits across the page boundary. A letter is short enough
   that keeping each one whole cannot strand much, and half a paragraph overleaf
   reads far worse on a letter than it does on a Resume. */
.body-paragraph { break-inside: avoid; }

/* ---------- Sign-off ---------- */
.closing { padding: 16pt 0 0; }
.signature {
  font-weight: bold;
  /* The gap a handwritten signature would occupy. */
  padding: 22pt 0 0;
}
`;

/** One paragraph's runs, with the emphasised ones in bold. */
function renderSpans(spans: { text: string; bold: boolean }[]): string {
  return spans
    .map((span) => (span.bold ? `<b>${esc(span.text)}</b>` : esc(span.text)))
    .join('');
}

export function renderCoverLetterHtml(model: CoverLetterModel): string {
  const parts: string[] = [];

  // ---- Letterhead ----
  parts.push('<div class="rule">');
  parts.push(`<p class="name">${esc(model.name)}</p>`);
  if (model.personal.length) {
    parts.push(`<p class="personal">${pipeJoin(model.personal.map(esc))}</p>`);
  }
  parts.push('</div>');

  if (model.date) parts.push(`<p class="date">${esc(model.date)}</p>`);

  if (model.recipient.length) {
    parts.push('<div class="recipient">');
    for (const line of model.recipient) parts.push(`<p>${esc(line)}</p>`);
    parts.push('</div>');
  }

  parts.push(`<p class="greeting">${esc(model.greeting)}</p>`);

  // ---- Body ----
  for (const paragraph of model.paragraphs) {
    parts.push(`<p class="body-paragraph">${renderSpans(paragraph)}</p>`);
  }

  // ---- Sign-off ----
  parts.push(`<p class="closing">${esc(model.closing)}</p>`);
  parts.push(`<p class="signature">${esc(model.signature)}</p>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(model.name)}</title>
<style>${fontFaceCss()}</style>
<style>${STYLES}</style>
</head>
<body>
${parts.join('\n')}
</body>
</html>`;
}

export function buildCoverLetterHtml(
  profile: Profile,
  payload: CoverLetterPayload,
  context: CoverLetterContext = {},
): string {
  return renderCoverLetterHtml(buildCoverLetterModel(profile, payload, context));
}
