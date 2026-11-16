import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  LineRuleType,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from 'docx';
import { buildResumeModel, type ResumeModel } from './model.js';
import { inlineRuns, splitCategory, type TextRunSpec as InlineRun } from './inline.js';
import type { Profile } from '../../domain/types.js';
import type { ResumePayload } from '../resume.schemas.js';

/**
 * Renders the Resume model as a Word .docx, alongside the PDF that `html.ts`
 * produces from the same model.
 *
 * Ported from the resume-builder desktop app's `src/resumeDocx.js`, down to
 * every point size and space-before/after. The layout spec is written in
 * Word's own terms — Narrow margins, Calibri, point sizes, Multiple-1 line
 * spacing — so this renderer states those values directly rather than
 * translating CSS. That also makes it the more literal of the two outputs; the
 * stylesheet in `html.ts` is the one doing the approximating.
 *
 * **Written to be read by a machine first**, like the PDF: one column, no
 * tables, no text boxes, no images, nothing in the page header or footer, and
 * the section headings an applicant tracking system looks for — `Summary`,
 * `Skills`, `Work Experience`, `Education` — in the order a Resume
 * conventionally puts them. The name and those headings carry Word's own
 * `Title` and `Heading 1` styles rather than being bold paragraphs that merely
 * look like headings: the styles are redefined below to the exact type this
 * template specifies, so the document looks the same and says what it is. A
 * converter reading the file gets an outline; one reading only the text gets
 * the same words in the same order.
 *
 * Keep the two renderers in step: a spacing or ordering change in one needs the
 * matching change in the other.
 */

/** Word measures spacing and indents in twips: 1pt = 20, 1 inch = 1440. */
const pt = (points: number) => Math.round(points * 20);
/** Font sizes are in half-points. */
const half = (points: number) => Math.round(points * 2);

const FONT = 'Calibri';
const COLOR = '1A1A1A';
const BULLET_REF = 'resume-bullets';

/**
 * "Multiple 1.15" — the font's own line height with the extra leading a
 * printed page reads better for. Word counts 240 twips as one line.
 */
const SINGLE = { line: Math.round(240 * 1.15), lineRule: LineRuleType.AUTO };

/** Space before/after for each kind of paragraph, in points. */
const SPACING = {
  name: { before: 0, after: 4 },
  personal: { before: 0, after: 9 },
  heading: { before: 10, after: 3 },
  summary: { before: 5, after: 0 },
  skill: { before: 5, after: 0 },
  // An entry is two lines: the employer's and then the role's. The space above
  // belongs to the first of them and the space below to the second, so only
  // the pair is separated from the entry before it.
  company: { before: 9, after: 0 },
  role: { before: 0, after: 3 },
  bullet: { before: 2.5, after: 0 },
  eduInfo: { before: 5, after: 0 },
  degree: { before: 0, after: 0 },
} as const;

/**
 * The type, in points. The body size is the contact line, the summary and the
 * skills; everything set differently is named here. The stylesheet in
 * `html.ts` carries the same numbers — the two renderers are one template.
 */
const BODY_PT = 10;
const NAME_PT = 23;
const HEADING_PT = 12;
const ROLE_PT = 11.5;
/** The employer's line, and the location and dates that close the two lines with it. */
const EMPLOYER_PT = 10.5;
const BULLET_PT = 10;
const EDUCATION_PT = 10;

/**
 * Where the right-hand half of a line lands: the width of the page inside its
 * margins, 8.5in less two 0.5in margins, in twips. A right tab stop there is
 * how Word puts a date against the right margin without a table — which a
 * Resume must not have, since a parser reads a table cell by cell.
 */
const RIGHT_TAB = pt(612 - 36 - 36);

const spacing = (key: keyof typeof SPACING) => ({
  ...SINGLE,
  before: pt(SPACING[key].before),
  after: pt(SPACING[key].after),
});

/**
 * The separator between the fields of the personal line.
 * CSS can pad a pipe by an exact 4.5pt a side; Word cannot, so the gap has to be
 * made of spaces. Calibri's space is 0.2265em — 2.27pt at 10pt type — so two a
 * side comes to 4.54pt, within a rounding error of the stylesheet. Plain U+0020
 * rather than a single en space (5pt, marginally closer) because some Resume
 * parsers count only ASCII whitespace as a word boundary.
 */
const SEP = '  |  ';

const run = (text: string, opts: Record<string, unknown> = {}) =>
  new TextRun({ text, font: FONT, color: COLOR, ...opts });

/** Styled runs as Word runs, at a size when the line is not set in the body's. */
const runsOf = (pieces: InlineRun[], points?: number): TextRun[] =>
  pieces.map((piece) =>
    run(piece.text, {
      ...(piece.bold ? { bold: true } : {}),
      ...(piece.italic ? { italics: true } : {}),
      ...(points ? { size: half(points) } : {}),
    }),
  );

/** One line of the payload's Markdown, as the runs Word needs to print its emphasis. */
const md = (source: string, base: { bold?: boolean; italics?: boolean; size?: number } = {}): TextRun[] =>
  runsOf(
    inlineRuns(source, { ...(base.bold ? { bold: true } : {}), ...(base.italics ? { italic: true } : {}) }),
    base.size,
  );

/**
 * A line with something against each margin. The two halves are separated by a
 * tab, which is what Word puts against the right stop — and what a reader
 * taking the text of the file sees as one line, left half first.
 */
function spread(
  left: TextRun[],
  right: string,
  options: { spacing: object; keepNext?: boolean; italics?: boolean; rightSize?: number },
): Paragraph {
  const { rightSize, italics, ...paragraph } = options;
  return new Paragraph({
    ...paragraph,
    ...(right ? { tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }] } : {}),
    children: right
      ? [
          ...left,
          run(`\t${right}`, {
            ...(italics ? { italics: true } : {}),
            ...(rightSize ? { size: half(rightSize) } : {}),
          }),
        ]
      : left,
  });
}

function buildDocxDocument(model: ResumeModel): Document {
  const children: Paragraph[] = [];

  /**
   * A section heading: 13pt bold with the hairline rule beneath, and Word's
   * `Heading 1` behind it — which is what carries the outline level a parser
   * or a converter reads the document's structure from. The style is redefined
   * below, so nothing of Word's own blue Calibri Light shows through.
   */
  const heading = (text: string) =>
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: spacing('heading'),
      // Never leave a heading stranded at the foot of a page.
      keepNext: true,
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          // Border widths are in eighths of a point: 0.75pt.
          size: 6,
          color: '888888',
          space: 1,
        },
      },
      children: [run(text.toUpperCase(), { bold: true, size: half(HEADING_PT), characterSpacing: 8 })],
    });

  // ---- Header ----
  // The name is the document's title in Word's sense as well as in the
  // reader's: whose Resume this is, is the one thing a parser must not have to
  // guess at.
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: spacing('name'),
      alignment: AlignmentType.LEFT,
      children: [run(model.name, { bold: true, size: half(NAME_PT) })],
    }),
  );
  if (model.personal.length) {
    children.push(
      new Paragraph({
        spacing: spacing('personal'),
        alignment: AlignmentType.LEFT,
        children: [run(model.personal.join(SEP))],
      }),
    );
  }

  // ---- Summary ----
  if (model.summary.length) {
    children.push(heading('Summary'));
    for (const line of model.summary) {
      children.push(new Paragraph({ spacing: spacing('summary'), children: md(line) }));
    }
  }

  // ---- Skills ----
  // "Skills", not "Core Skills": a parser looks for the heading it knows, and
  // a section it cannot name is a section whose contents it files nowhere.
  if (model.skills.length) {
    children.push(heading('Skills'));
    for (const skill of model.skills) {
      // The category is bold whether or not the payload said so, and the split
      // happens after the Markdown is read — `**Languages:** Go` and
      // `Languages: Go` print the same.
      const [category, rest] = splitCategory(inlineRuns(skill));
      children.push(
        new Paragraph({
          spacing: spacing('skill'),
          children: [...runsOf(category.map((piece) => ({ ...piece, bold: true }))), ...runsOf(rest)],
        }),
      );
    }
  }

  // ---- Work Experience ----
  if (model.jobs.length) {
    children.push(heading('Work Experience'));
    for (const job of model.jobs) {
      // keepNext on both header lines holds them together and keeps them with
      // the first bullet, so an entry never starts at the foot of a page alone.
      children.push(
        spread([run(job.company, { italics: true, size: half(EMPLOYER_PT) })], job.dates, {
          spacing: spacing('company'),
          keepNext: true,
          italics: true,
          rightSize: EMPLOYER_PT,
        }),
      );
      children.push(
        spread(md(job.title, { bold: true, size: ROLE_PT }), job.location, {
          spacing: spacing('role'),
          keepNext: true,
          rightSize: EMPLOYER_PT,
        }),
      );
      for (const bullet of job.bullets) {
        children.push(
          new Paragraph({
            spacing: spacing('bullet'),
            // One bullet's wrapped lines stay together rather than splitting
            // mid-sentence; the role as a whole may still break across pages.
            keepLines: true,
            numbering: { reference: BULLET_REF, level: 0 },
            children: md(bullet, { size: BULLET_PT }),
          }),
        );
      }
    }
  }

  // ---- Education ----
  // Last, which is where a Resume for someone with a work history puts it —
  // and where a parser reading top to bottom expects the dates to stop being
  // employment dates.
  if (model.education) {
    children.push(heading('Education'));
    children.push(
      spread([run(model.education.school, { italics: true, size: half(EDUCATION_PT) })], model.education.dates, {
        spacing: spacing('eduInfo'),
        keepNext: true,
        italics: true,
        rightSize: EDUCATION_PT,
      }),
    );
    if (model.education.degree) {
      children.push(
        new Paragraph({
          spacing: spacing('degree'),
          children: [run(model.education.degree, { bold: true, size: half(EDUCATION_PT) })],
        }),
      );
    }
  }

  return new Document({
    creator: model.name,
    lastModifiedBy: model.name,
    title: model.name,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: half(BODY_PT), color: COLOR },
          paragraph: { spacing: SINGLE },
        },
        // Word's own `Title` and `Heading 1` are 28pt and blue 16pt, and
        // applying them as they come would restyle the document. Redefined to
        // the type this template specifies, so what the paragraphs above gain
        // is the style — the outline level, the name a converter reads by —
        // and not a different-looking Resume. Redefined *here*, under
        // `default`, rather than added as paragraph styles of the same names:
        // the library writes its own definitions either way, and a second
        // `Title` in one stylesheet is a file Word offers to repair.
        title: {
          run: { font: FONT, size: half(NAME_PT), bold: true, color: COLOR },
          paragraph: { spacing: spacing('name') },
        },
        heading1: {
          run: { font: FONT, size: half(HEADING_PT), bold: true, color: COLOR, characterSpacing: 8 },
          paragraph: { spacing: spacing('heading'), keepNext: true },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: BULLET_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '•',
              alignment: AlignmentType.LEFT,
              style: {
                run: { font: FONT, color: COLOR },
                // Text sits 9.5pt inside the margin with the bullet at 2.5pt,
                // matching the stylesheet's 2.5pt list indent + 7pt marker gap.
                paragraph: { indent: { left: pt(9.5), hanging: pt(7) } },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            // US Letter, portrait, with Word's Narrow margins (0.5" all round).
            size: { width: pt(612), height: pt(792) },
            margin: {
              top: pt(36),
              right: pt(36),
              bottom: pt(36),
              left: pt(36),
              header: pt(36),
              footer: pt(36),
              gutter: 0,
            },
          },
        },
        children,
      },
    ],
  });
}

/** The .docx file as a Buffer, ready to be sent. */
export function buildResumeDocx(profile: Profile, payload: ResumePayload): Promise<Buffer> {
  return Packer.toBuffer(buildDocxDocument(buildResumeModel(profile, payload)));
}
