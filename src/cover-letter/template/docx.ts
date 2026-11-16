import {
  AlignmentType,
  BorderStyle,
  Document,
  LineRuleType,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import {
  buildCoverLetterModel,
  type CoverLetterContext,
  type CoverLetterModel,
  type Span,
} from './model.js';
import type { Profile } from '../../domain/types.js';
import type { CoverLetterPayload } from '../cover-letter.schemas.js';

/**
 * Renders the cover letter model as a Word .docx, alongside the PDF that
 * `html.ts` produces from the same model.
 *
 * The same relationship the Resume's two renderers have: this one states the
 * layout in Word's own terms — points, twips, Narrow margins — and the
 * stylesheet next door approximates it in CSS. Keep the two in step: a spacing
 * or ordering change in one needs the matching change in the other.
 */

/** Word measures spacing and indents in twips: 1pt = 20, 1 inch = 1440. */
const pt = (points: number) => Math.round(points * 20);
/** Font sizes are in half-points. */
const half = (points: number) => Math.round(points * 2);

const FONT = 'Calibri';
const COLOR = '1A1A1A';

/** Word's "Multiple 1.15", which is what the stylesheet's 1.4 leading comes to. */
const BODY_LINE = { line: 276, lineRule: LineRuleType.AUTO };

/** Space before/after for each kind of paragraph, in points. */
const SPACING = {
  name: { before: 0, after: 3 },
  personal: { before: 0, after: 1.5 },
  date: { before: 14, after: 0 },
  recipient: { before: 14, after: 0 },
  recipientLine: { before: 0, after: 0 },
  greeting: { before: 14, after: 0 },
  paragraph: { before: 11, after: 0 },
  closing: { before: 16, after: 0 },
  signature: { before: 22, after: 0 },
} as const;

const spacing = (key: keyof typeof SPACING) => ({
  ...BODY_LINE,
  before: pt(SPACING[key].before),
  after: pt(SPACING[key].after),
});

/**
 * The separator on the contact line — the same two-spaces-a-side pipe the
 * Resume uses, for the same reason: CSS can pad a pipe by an exact 4.5pt and
 * Word cannot, so the gap has to be made of spaces.
 */
const SEP = '  |  ';

const run = (text: string, opts: Record<string, unknown> = {}) =>
  new TextRun({ text, font: FONT, color: COLOR, ...opts });

/** One paragraph's runs, with the emphasised ones in bold. */
const spanRuns = (spans: Span[]) => spans.map((span) => run(span.text, { bold: span.bold }));

function buildCoverLetterDocument(model: CoverLetterModel): Document {
  const children: Paragraph[] = [];

  // ---- Letterhead ----
  children.push(
    new Paragraph({
      spacing: spacing('name'),
      alignment: AlignmentType.LEFT,
      keepNext: true,
      children: [run(model.name, { bold: true, size: half(20) })],
    }),
  );

  // The rule under the letterhead hangs off whichever line is last in it, so
  // that a profile with no contact details does not lose the separator.
  const ruledBorder = {
    bottom: {
      style: BorderStyle.SINGLE,
      // Border widths are in eighths of a point: 0.75pt.
      size: 6,
      color: '888888',
      space: 1,
    },
  };

  if (model.personal.length) {
    children.push(
      new Paragraph({
        spacing: spacing('personal'),
        border: ruledBorder,
        children: [run(model.personal.join(SEP))],
      }),
    );
  } else {
    children[0] = new Paragraph({
      spacing: spacing('name'),
      alignment: AlignmentType.LEFT,
      border: ruledBorder,
      children: [run(model.name, { bold: true, size: half(20) })],
    });
  }

  if (model.date) {
    children.push(new Paragraph({ spacing: spacing('date'), children: [run(model.date)] }));
  }

  // ---- Addressee ----
  model.recipient.forEach((line, index) => {
    children.push(
      new Paragraph({
        spacing: spacing(index === 0 ? 'recipient' : 'recipientLine'),
        keepNext: true,
        children: [run(line)],
      }),
    );
  });

  children.push(
    new Paragraph({
      spacing: spacing('greeting'),
      keepNext: true,
      children: [run(model.greeting)],
    }),
  );

  // ---- Body ----
  for (const paragraph of model.paragraphs) {
    children.push(
      new Paragraph({
        spacing: spacing('paragraph'),
        // A letter is short enough that keeping each paragraph whole cannot
        // strand much, and half a paragraph overleaf reads far worse here than
        // it does on a Resume.
        keepLines: true,
        children: spanRuns(paragraph),
      }),
    );
  }

  // ---- Sign-off ----
  children.push(
    new Paragraph({
      spacing: spacing('closing'),
      keepNext: true,
      children: [run(model.closing)],
    }),
  );
  children.push(
    new Paragraph({
      spacing: spacing('signature'),
      children: [run(model.signature, { bold: true })],
    }),
  );

  return new Document({
    creator: model.name,
    lastModifiedBy: model.name,
    title: `${model.name} — Cover Letter`,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: half(11), color: COLOR },
          paragraph: { spacing: BODY_LINE },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            // US Letter, portrait, with Word's Narrow margins (0.5" all round)
            // — the Resume's page, so the two documents match.
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
export function buildCoverLetterDocx(
  profile: Profile,
  payload: CoverLetterPayload,
  context: CoverLetterContext = {},
): Promise<Buffer> {
  return Packer.toBuffer(buildCoverLetterDocument(buildCoverLetterModel(profile, payload, context)));
}
