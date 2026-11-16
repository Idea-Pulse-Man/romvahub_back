import type { Profile } from '../../domain/types.js';
import type { CoverLetterPayload } from '../cover-letter.schemas.js';

/**
 * Turns the user's profile and the AI's payload into the cover letter's
 * content, with no regard for how it will be presented.
 *
 * The same split the Resume's model makes, and for the same reason:
 *
 *   Profile   name, contact line, signature
 *   Payload   greeting, the four paragraphs, closing
 *
 * Who the letter is from is a fact about the person, so it comes from the
 * profile and is never sent to the AI. What the letter *says* is tailored per
 * application, so it comes from the payload. Nothing is sourced from both.
 *
 * Both output formats — `html.ts` (HTML → PDF) and `docx.ts` (.docx) — render
 * this same model, so the two files can never disagree about what the letter
 * says. Only the styling of each lives in its own module.
 */

/**
 * A run of text, and whether it is bold.
 *
 * The prompt asks for a little `**bold**` inside the paragraphs, so a paragraph
 * is a list of these rather than a string. Parsing it here rather than in each
 * renderer is what keeps the PDF and the Word file emphasising the same words:
 * two parsers would drift the first time either was touched.
 */
export interface Span {
  text: string;
  bold: boolean;
}

/**
 * Splits `**bold**` out of a paragraph.
 *
 * Deliberately the *only* markup understood. The letter is prose with a few
 * emphasised phrases in it, not a Markdown document — running it through a
 * Markdown renderer would mean an underscore in a company name turning into
 * italics, and a lone asterisk swallowing the rest of the sentence.
 *
 * An unclosed `**` is left as literal text rather than treated as an opener to
 * the end of the paragraph: a model that emits one stray marker should cost two
 * visible asterisks, not a paragraph that is entirely bold.
 */
export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = /\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*/g;

  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      spans.push({ text: text.slice(cursor, match.index), bold: false });
    }
    spans.push({ text: match[1]!, bold: true });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) spans.push({ text: text.slice(cursor), bold: false });

  // A paragraph of nothing but markers would otherwise render as an empty
  // block that still takes its spacing.
  return spans.filter((span) => span.text.length > 0);
}

/** "2026-09-02" → "September 2, 2026", the form a letter dates itself in. */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatLetterDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return '';

  const monthIndex = Number.parseInt(match[2]!, 10) - 1;
  if (monthIndex < 0 || monthIndex > 11) return '';

  return `${MONTHS[monthIndex]} ${Number.parseInt(match[3]!, 10)}, ${match[1]}`;
}

/**
 * The letter's content. Every string is plain text — escaping is the HTML
 * renderer's business, not this module's.
 */
export interface CoverLetterModel {
  name: string;
  /** Location, email and phone — pipe-joined onto one line, as on the Resume. */
  personal: string[];
  /** Empty when the caller supplied no date, which prints no date line. */
  date: string;
  /** Who the letter is addressed to, and about what. */
  recipient: string[];
  greeting: string;
  paragraphs: Span[][];
  closing: string;
  /** The name again, under the sign-off. */
  signature: string;
}

export interface CoverLetterContext {
  /** `YYYY-MM-DD`. The application's own date where there is one, else today's. */
  date?: string;
}

export function buildCoverLetterModel(
  profile: Profile,
  payload: CoverLetterPayload,
  context: CoverLetterContext = {},
): CoverLetterModel {
  // The same header the Resume carries, so the two documents in one application
  // are visibly the same person's.
  const name = `${profile.firstName || ''} ${profile.lastName || ''}`.trim();
  const personal = [profile.location, profile.email, profile.phone].filter(Boolean);

  const company = payload.company.trim();
  const role = payload.role.trim();

  return {
    name: name || 'Your Name',
    personal,
    date: context.date ? formatLetterDate(context.date) : '',
    // "Hiring Team, Acme Corp" over "Re: Senior Backend Engineer" — the block a
    // letter puts above its salutation. Both halves are dropped when the
    // document did not name them.
    recipient: [
      company ? `Hiring Team, ${company}` : '',
      role ? `Re: ${role}` : '',
    ].filter(Boolean),
    greeting: payload.greeting.trim() || 'Dear Hiring Manager,',
    paragraphs: payload.paragraphs
      .map((paragraph) => String(paragraph ?? '').trim())
      .filter(Boolean)
      .map(parseSpans),
    closing: payload.closing.trim() || 'Sincerely,',
    signature: name || 'Your Name',
  };
}
