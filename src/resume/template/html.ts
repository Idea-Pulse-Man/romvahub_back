import { buildResumeModel, type ResumeModel } from './model.js';
import { inlineRuns, splitCategory, type TextRunSpec } from './inline.js';
import { fontFaceCss } from './fonts.js';
import type { Profile } from '../../domain/types.js';
import type { ResumePayload } from '../resume.schemas.js';

/**
 * Renders the Resume model as a standalone HTML document, which is then turned
 * into a PDF by headless Chromium.
 *
 * The stylesheet is the resume-builder desktop app's `src/resumeTemplate.js`,
 * which is where this template was specified. Reusing the CSS — rather than
 * re-deriving the same layout in a PDF drawing library — is what makes the two
 * outputs the same document: every margin, size, font and space is the one
 * that was already specified, not one approximated from it.
 *
 * **Written to be read by a machine first.** A Resume is parsed by an applicant
 * tracking system before a person sees it, and what those parsers want is the
 * plain end of the format: one column, no tables, no text boxes, no images, no
 * icons standing in for words, real text in the reading order it is printed in,
 * a font that exists on every machine, and the section headings they are
 * looking for — `Summary`, `Skills`, `Work Experience`, `Education` — in the
 * order a Resume conventionally puts them. Nothing here is decorative: the
 * name is an `h1`, the sections are `h2`s, the bullets are a list, and the PDF
 * is printed tagged so that structure survives into the file rather than being
 * flattened into placed glyphs.
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

/** Styled runs as escaped HTML. */
function html(runs: TextRunSpec[]): string {
  return runs
    .map((run) => {
      const text = esc(run.text);
      if (!text) return '';
      const open = `${run.bold ? '<strong>' : ''}${run.italic ? '<em>' : ''}`;
      const close = `${run.italic ? '</em>' : ''}${run.bold ? '</strong>' : ''}`;
      return `${open}${text}${close}`;
    })
    .join('');
}

/** One line of the payload's Markdown, as escaped HTML with its emphasis kept. */
function md(source: string, base: { bold?: boolean; italic?: boolean } = {}): string {
  return html(inlineRuns(source, base));
}

/**
 * A line with something against each margin: the role and its dates, the
 * employer and its location, the university and its years.
 *
 * Two spans in a row rather than a table, and in the order they are read, so
 * that a parser taking the text of the page gets "Senior Engineer" before
 * "Aug 2024 - Present" and never sees a cell.
 */
function spread(left: string, right: string, className: string): string {
  if (!right) return `<p class="${className}">${left}</p>`;
  return `<p class="${className} spread"><span>${left}</span><span class="right">${right}</span></p>`;
}

/* Word's space-before / space-after ADD up between two paragraphs, while adjacent
   CSS margins collapse to the larger of the two. To reproduce Word's arithmetic,
   "space before" is always padding-top (padding never collapses) and "space after"
   is always padding-bottom, with every margin left at 0. */
const STYLES = `
/* US Letter with Word's Narrow margins (0.5" all round). The PDF is printed with
   preferCSSPageSize so these values, not the printer's own defaults, decide the page. */
@page {
  size: 8.5in 11in;
  margin: 0.5in;
}

* { box-sizing: border-box; }

html, body { margin: 0; padding: 0; }

body {
  /* Calibri is the spec. The @font-face above binds that name to Carlito, which
     is metric-compatible, so the layout does not depend on the host's fonts. */
  font-family: Calibri, Carlito, "Noto Sans", "Segoe UI", sans-serif;
  /* The body size: the contact line, the summary and the skills. Every part
     that is set differently says so, and each of those sizes is in docx.ts
     too — the two renderers are one template. */
  font-size: 10pt;
  /* Word's "Multiple 1" line spacing is the font's own natural line height —
     Calibri's is (ascent 750 + descent 250 + gap 221) / 1000 em. This is
     "Multiple 1.15" on top of it, the extra leading a printed page reads
     better for. */
  line-height: 1.4;
  color: #1a1a1a;
  -webkit-font-smoothing: antialiased;
}

p, h1, h2 { margin: 0; }

/* ---------- Header ---------- */
/* The name is the document's h1 — the one heading a parser reads as whose
   Resume this is — and is sized here rather than left at the browser's 2em. */
.name {
  font-size: 23pt;
  font-weight: bold;
  text-align: left;
  padding: 0 0 4pt;
}
.personal {
  text-align: left;
  padding: 0 0 9pt;
}

/* ---------- Sections ---------- */
h2 {
  font-size: 12pt;
  font-weight: bold;
  /* Set in capitals rather than typed in them, so the text a parser reads is
     still "Work Experience". */
  text-transform: uppercase;
  letter-spacing: 0.4pt;
  margin: 0;
  padding: 10pt 0 3pt;
  /* Word draws a paragraph's bottom border below its space-after, so the rule
     sits under the 3pt rather than between it and the heading text. */
  border-bottom: 0.75pt solid #888888;
}
section { break-inside: auto; }
h2 { break-after: avoid; }

.sep {
  font-weight: normal;
  padding: 0 4.5pt;
}

.summary-text { padding: 5pt 0 0; }
.skill { padding: 5pt 0 0; }

/* ---------- A line with something against each margin ---------- */
/* Two spans in a row, which keeps them in reading order for anything taking
   the text of the page — a table would not. */
.spread {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 18pt;
}
.spread .right {
  flex: none;
  text-align: right;
  white-space: nowrap;
}

/* ---------- Work Experience ---------- */
/* A role may split across a page boundary. Forcing the whole block to stay
   together pushed any role that did not fit wholesale onto the next page and
   left a large gap at the bottom of the previous one. */
.job { break-inside: auto; }

/* What must NOT split: the two header lines stay together, and a role never
   starts at the very foot of a page with its bullets stranded overleaf. */
.job-head {
  break-inside: avoid;
  break-after: avoid;
}
/* An entry is the employer's line and then the role's. The space above an
   entry belongs to whichever comes first, and the space below to the second —
   the two are a pair, and only the pair is separated from the last one. */
.company {
  font-size: 10.5pt;
  font-style: italic;
  padding: 9pt 0 0;
}
.role {
  font-size: 11.5pt;
  font-weight: bold;
  padding: 0 0 3pt;
}
/* What sits against the right margin — the dates beside the employer, the
   location beside the role — is set at the employer's size and in the weight
   of the line it closes, not in the role's bold. */
.role .right {
  font-size: 10.5pt;
  font-weight: normal;
}
.job ul {
  margin: 0;
  /* The marker is drawn by ::before rather than list-style, because the gap
     between a native marker and its text is not directly settable in CSS. */
  list-style: none;
  padding-left: 2.5pt;
}
.job li {
  margin: 0;
  font-size: 10pt;
  position: relative;
  padding-top: 2.5pt;
  /* Keep one bullet's wrapped lines together rather than splitting mid-sentence. */
  break-inside: avoid;
  /* Distance from the bullet to the start of the sentence. */
  padding-left: 9pt;
}
.job li::before {
  content: "\\2022";
  position: absolute;
  left: 0;
}

/* ---------- Education ---------- */
/* Education is set at the body size throughout — the university, the degree
   and the years — and reads the same way round as an entry above it: the
   institution first, what was studied there second. */
.edu-info {
  font-size: 10pt;
  font-style: italic;
  padding: 5pt 0 0;
}
.degree {
  font-size: 10pt;
  font-weight: bold;
}
`;

export function renderResumeHtml(model: ResumeModel): string {
  const parts: string[] = [];

  // ---- Header ----
  parts.push(`<h1 class="name">${esc(model.name)}</h1>`);
  if (model.personal.length) {
    parts.push(`<p class="personal">${pipeJoin(model.personal.map(esc))}</p>`);
  }

  // ---- Summary ----
  if (model.summary.length) {
    parts.push('<section><h2>Summary</h2>');
    for (const line of model.summary) {
      parts.push(`<p class="summary-text">${md(line)}</p>`);
    }
    parts.push('</section>');
  }

  // ---- Skills ----
  // "Skills", not "Core Skills": a parser looks for the heading it knows, and
  // a section it cannot name is a section whose contents it files nowhere.
  if (model.skills.length) {
    parts.push('<section><h2>Skills</h2>');
    for (const skill of model.skills) {
      // The category is bold whether or not the payload said so, and the split
      // happens after the Markdown is read — `**Languages:** Go` and
      // `Languages: Go` print the same.
      const [category, rest] = splitCategory(inlineRuns(skill));
      parts.push(
        `<p class="skill">${html(category.map((run) => ({ ...run, bold: true })))}${html(rest)}</p>`,
      );
    }
    parts.push('</section>');
  }

  // ---- Work Experience ----
  if (model.jobs.length) {
    parts.push('<section><h2>Work Experience</h2>');
    for (const job of model.jobs) {
      parts.push('<div class="job">');
      parts.push('<div class="job-head">');
      // The employer with its dates against the right margin, the role with
      // its location under it — each reading left to right as one line.
      parts.push(spread(esc(job.company), esc(job.dates), 'company'));
      parts.push(spread(md(job.title), esc(job.location), 'role'));
      parts.push('</div>');
      if (job.bullets.length) {
        parts.push(`<ul>${job.bullets.map((bullet) => `<li>${md(bullet)}</li>`).join('')}</ul>`);
      }
      parts.push('</div>');
    }
    parts.push('</section>');
  }

  // ---- Education ----
  // Last, which is where a Resume for someone with a work history puts it —
  // and where a parser reading top to bottom expects the dates to stop being
  // employment dates.
  if (model.education) {
    parts.push('<section><h2>Education</h2>');
    parts.push(spread(esc(model.education.school), esc(model.education.dates), 'edu-info'));
    if (model.education.degree) {
      parts.push(`<p class="degree">${esc(model.education.degree)}</p>`);
    }
    parts.push('</section>');
  }

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

export function buildResumeHtml(profile: Profile, payload: ResumePayload): string {
  return renderResumeHtml(buildResumeModel(profile, payload));
}
