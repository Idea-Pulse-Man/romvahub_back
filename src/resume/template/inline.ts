/**
 * The Markdown a Resume's text is written in, as runs of styled text.
 *
 * Every string the AI supplies — the summary, the skills, the role titles, the
 * bullets — is Markdown, because that is what the form's editor produces and
 * what the model is asked for. Printed literally, `**Led** the migration`
 * reaches a recruiter with its asterisks on. Both renderers ask this module
 * what the text is made of and then say it in their own terms: `<strong>` and
 * `<em>` in the HTML the PDF is printed from, `bold` and `italics` on a run in
 * Word.
 *
 * Inline only, and deliberately: a Resume's paragraphs and bullets are the
 * template's to lay out, not the text's. A line that arrives as `## Heading`
 * or `- item` keeps those characters, because a payload that could open a
 * section or start a list could rearrange the document.
 *
 * What is read:
 *
 * - `**bold**`, `__bold__`
 * - `*italic*`, `_italic_`
 * - `***both***`, `___both___`
 * - `` `code` `` — printed as the text inside, since a Resume has no monospace
 * - `[text](url)` — printed as the text, the URL being of no use on paper
 * - `\*` — an escaped marker, printed as the character
 *
 * Anything else is text: an asterisk with a space after it is a multiplication
 * sign or a footnote, `C*` is a language, and an unclosed marker is someone's
 * punctuation rather than an intention.
 */

export interface TextRunSpec {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

/** `**`, `__`, `*`, `_`, `` ` ``, in the order they have to be tried. */
const MARKERS: { marker: string; bold?: boolean; italic?: boolean; code?: boolean }[] = [
  { marker: '***', bold: true, italic: true },
  { marker: '___', bold: true, italic: true },
  { marker: '**', bold: true },
  { marker: '__', bold: true },
  { marker: '*', italic: true },
  { marker: '_', italic: true },
  { marker: '`', code: true },
];

/**
 * Where a marker's closing half is, or -1. A closing marker cannot be preceded
 * by a space — `2 * 3 * 4` is arithmetic — and, for the doubled markers, must
 * not be part of a longer run than the one that opened it.
 */
function closingIndex(text: string, marker: string, from: number): number {
  for (let at = text.indexOf(marker, from); at !== -1; at = text.indexOf(marker, at + 1)) {
    if (at === from) continue; // `**` with nothing inside is not emphasis
    if (/\s/.test(text[at - 1] ?? '')) continue;
    if (text[at - 1] === '\\') continue;
    return at;
  }
  return -1;
}

/** Merges a run into the last one when they are styled alike, so runs stay whole words. */
function push(runs: TextRunSpec[], text: string, bold: boolean, italic: boolean): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && !!last.bold === bold && !!last.italic === italic) {
    last.text += text;
    return;
  }
  runs.push({ text, ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}) });
}

/**
 * Reads one line of Markdown as the runs it is made of. Always at least one
 * run — an empty line reads as a single empty one — so a caller can print the
 * result without checking for nothing.
 */
export function inlineRuns(source: string, base: { bold?: boolean; italic?: boolean } = {}): TextRunSpec[] {
  const runs: TextRunSpec[] = [];
  const baseBold = !!base.bold;
  const baseItalic = !!base.italic;
  let plain = '';
  let index = 0;

  const flush = () => {
    push(runs, plain, baseBold, baseItalic);
    plain = '';
  };

  while (index < source.length) {
    const character = source[index]!;

    // A backslash makes the next character literal, which is how a Resume
    // writes an asterisk it means.
    if (character === '\\' && index + 1 < source.length) {
      plain += source[index + 1];
      index += 2;
      continue;
    }

    // `[text](url)`: the text is what a printed page can use.
    if (character === '[') {
      const link = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(source.slice(index));
      if (link) {
        plain += link[1];
        index += link[0].length;
        continue;
      }
    }

    const opening = MARKERS.find(
      ({ marker }) =>
        source.startsWith(marker, index) &&
        // An opening marker is followed by the text it emphasises, not by a space.
        !/\s/.test(source[index + marker.length] ?? ' '),
    );
    if (opening) {
      const from = index + opening.marker.length;
      const close = closingIndex(source, opening.marker, from);
      if (close !== -1) {
        flush();
        const inner = source.slice(from, close);
        const bold = baseBold || !!opening.bold;
        const italic = baseItalic || !!opening.italic;
        if (opening.code) {
          // Code is printed as its text; nothing inside it is Markdown.
          push(runs, inner, baseBold, baseItalic);
        } else {
          for (const run of inlineRuns(inner, { bold, italic })) {
            push(runs, run.text, !!run.bold, !!run.italic);
          }
        }
        index = close + opening.marker.length;
        continue;
      }
    }

    plain += character;
    index += 1;
  }

  flush();
  return runs.length > 0 ? runs : [{ text: '' }];
}

/**
 * A skills line's category and the skills it lists: everything up to and
 * including the first colon, and the rest.
 *
 * Split *after* the Markdown is read rather than before it. A payload that
 * writes `**Languages:** Java` puts the colon inside the emphasis, and cutting
 * the string at that colon would leave half a marker on each side — which is
 * how `**Languages:` and `** Java` came to be printed with their asterisks on.
 *
 * A line with no colon has no category and is all skills.
 */
export function splitCategory(runs: TextRunSpec[]): [TextRunSpec[], TextRunSpec[]] {
  const category: TextRunSpec[] = [];
  const rest: TextRunSpec[] = [];
  let found = false;

  for (const piece of runs) {
    if (found) {
      rest.push(piece);
      continue;
    }
    const colon = piece.text.indexOf(':');
    if (colon === -1) {
      category.push(piece);
      continue;
    }
    found = true;
    const head = piece.text.slice(0, colon + 1);
    const tail = piece.text.slice(colon + 1);
    if (head) category.push({ ...piece, text: head });
    if (tail) rest.push({ ...piece, text: tail });
  }

  return found ? [category, rest] : [[], runs];
}

/** The same text with its markers gone and no styling — for a `<title>`, or a file name. */
export function inlineText(source: string): string {
  return inlineRuns(source)
    .map((run) => run.text)
    .join('');
}
