import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

/**
 * The description is handed to the client as Markdown rather than as the
 * scraped HTML. Markdown is what the form's editor understands as input, and
 * it is also the cheap way to throw away everything a job page wraps its prose
 * in — tracking attributes, layout divs, inline styles, a class per element.
 * What survives is the structure a posting actually has: headings, lists,
 * emphasis and links.
 */

/**
 * Postings run long, and the bid's `jobDescription` column accepts 50k
 * characters of the *HTML* this Markdown becomes in the editor. Capping the
 * Markdown well below that leaves room for the tags to be added back.
 */
const MAX_MARKDOWN_CHARS = 20_000;

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  strongDelimiter: '**',
  hr: '---',
});

turndown.remove(['script', 'style', 'noscript', 'iframe']);

/**
 * Images in a posting are logos, tracking pixels and social badges. None of
 * them is the job description, and each one costs a line of noise.
 *
 * This is a rule rather than `remove()` because Turndown's own `image` rule
 * matches first — `remove()` is only consulted for tags no built-in rule claims.
 */
turndown.addRule('dropMedia', {
  filter: ['img', 'picture', 'video', 'audio', 'svg'],
  replacement: () => '',
});

/**
 * Turndown types its filter argument as the DOM's `HTMLElement`, which does not
 * exist in a Node-only `lib`. Only these three properties are ever read, and
 * the parser Turndown bundles supplies all of them.
 */
interface DomNode {
  nodeName: string;
  parentNode: DomNode | null;
  textContent: string | null;
  getAttribute?: (name: string) => string | null;
}

const asDomNode = (node: unknown) => node as DomNode;

/**
 * `<br>` inside a list item is a line break within the item; Turndown's default
 * emits a hard break that reads as a new item. Keeping it as a space is closer
 * to what the posting meant.
 */
turndown.addRule('lineBreakInListItem', {
  filter: (node) => asDomNode(node).nodeName === 'BR' && asDomNode(node).parentNode?.nodeName === 'LI',
  replacement: () => ' ',
});

/**
 * Some boards' editors (BambooHR's, for one) write bold and italic as styled
 * spans rather than `<strong>` and `<em>`, and a posting's section headings
 * are often nothing but a bold span. Turndown would drop the styling and with
 * it the only thing that set the heading apart from the prose.
 */
function styledEmphasis(node: unknown): 'bold' | 'italic' | undefined {
  const element = asDomNode(node);
  if (element.nodeName !== 'SPAN' || !element.getAttribute) return undefined;
  const style = element.getAttribute('style') ?? '';
  if (/font-weight\s*:\s*(?:bold|bolder|[6-9]00)\b/i.test(style)) return 'bold';
  if (/font-style\s*:\s*italic\b/i.test(style)) return 'italic';
  return undefined;
}

turndown.addRule('styledSpan', {
  filter: (node) => styledEmphasis(node) !== undefined,
  replacement: (content, node) => {
    const text = content.trim();
    if (!text) return content;
    const marker = styledEmphasis(node) === 'bold' ? '**' : '_';
    const leading = /^\s*/.exec(content)?.[0] ?? '';
    const trailing = /\s*$/.exec(content)?.[0] ?? '';
    return `${leading}${marker}${text}${marker}${trailing}`;
  },
});

/** A link with no text contributes nothing but brackets. */
turndown.addRule('emptyLink', {
  filter: (node) =>
    asDomNode(node).nodeName === 'A' && asDomNode(node).textContent?.trim() === '',
  replacement: () => '',
});

function tidy(markdown: string): string {
  return (
    markdown
      // Before anything measures a column: a job page is full of non-breaking
      // spaces, and a run of them at the start of a list item would otherwise
      // survive as padding after the bullet.
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b\ufeff]/g, '')
      .replace(/[ \t]+$/gm, '')
      // Turndown pads its bullets to four columns and job pages add more on top.
      // Five or more columns is an indented code block to CommonMark, not the
      // sentence it plainly is, so normalise every marker to one space.
      .replace(/^([ \t]*)([-*+])[ \t]+(?=\S)/gm, '$1$2 ')
      .replace(/^([ \t]*)(\d+\.)[ \t]+(?=\S)/gm, '$1$2 ')
      // Bullets typed as characters rather than marked up as a list.
      .replace(/^[ \t]*[•·▪●○]\s*/gm, '- ')
      // A heading with nothing in it — an editor's `<h1><br></h1>` spacer —
      // is a bare `#` line once converted, and reads as a stray character.
      .replace(/^#{1,6}[ \t]*$/gm, '')
      // `<b><strong>About us</strong></b>` — one emphasis inside the same
      // emphasis, which a rich-text editor produces without meaning anything
      // by it — converts to `****About us****`. Bold is bold once.
      .replace(/\*{4,}([^*\n]+?)\*{4,}/g, '**$1**')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** True when the string is prose rather than markup — JSON-LD supplies both. */
function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(value);
}

/**
 * Markup that arrived escaped — `&lt;p&gt;We are…&lt;/p&gt;` — is a posting
 * whose board encoded its HTML once more than it meant to before putting it
 * in JSON-LD (JOIN does). Read as text, every tag would land in the editor
 * spelled out. Decoded, it is markup like any other.
 *
 * One layer of entities is removed at a time, for the board that escaped
 * twice (`&amp;lt;p&amp;gt;`), and the result is kept only once real tags
 * appear: a description that is genuinely *about* HTML, `<code>&lt;section&gt;</code>`,
 * already has its tags and keeps its one layer of literal ones, and plain
 * prose that never becomes markup is returned as it came.
 */
export function unescapeMarkup(value: string): string {
  if (looksLikeHtml(value)) return value;
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = cheerio.load(current, null, false).root().text();
    if (decoded === current) return value;
    if (looksLikeHtml(decoded)) return decoded;
    current = decoded;
  }
  return value;
}

/**
 * Plain text arrives with its paragraphs already broken by newlines. Single
 * newlines become hard breaks so the shape of the posting survives a Markdown
 * renderer, which would otherwise collapse them.
 *
 * Note that `tidy` below strips trailing whitespace, so those two spaces do not
 * in fact survive — and it does not matter here, because the only consumer is a
 * language model reading the Markdown *source*, where the newline is already
 * the line break. It matters that this is harmless rather than that it works:
 * the frontend now sends the description as Markdown, and a transform that
 * appended two spaces to `- Requirement` and kept them would be editing text
 * that arrived correct.
 */
function textToMarkdown(value: string): string {
  return value
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, '  \n'))
    .join('\n\n');
}

export interface MarkdownResult {
  markdown: string;
  /** True when the posting was longer than the cap and was cut short. */
  truncated: boolean;
}

export function toMarkdown(description: string): MarkdownResult {
  const source = unescapeMarkup(description);
  const converted = looksLikeHtml(source) ? turndown.turndown(source) : textToMarkdown(source);

  return finishMarkdown(stripPageFurniture(converted));
}

/**
 * Markdown that arrived as Markdown — from the reader service the parser falls
 * back to — still needs the same last steps as markup we converted ourselves:
 * images gone (they are logos and badges there too), whitespace normalised,
 * and the length capped.
 */
export function tidyMarkdown(markdown: string): MarkdownResult {
  return finishMarkdown(stripPageFurniture(dropImages(markdown)));
}

function dropImages(markdown: string): string {
  return (
    markdown
      // A linked image, `[![logo](…)](…)`, would otherwise leave `[](…)` behind.
      .replace(/\[\s*!\[[^\]]*\]\([^)]*\)\s*\]\([^)]*\)/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[\s*\]\([^)]*\)/g, '')
  );
}

/**
 * A page read as Markdown is the posting plus whatever a browser shows around
 * it: share buttons, "Apply" and "Back", the cookie dialog, the footer. The
 * noise sweep in `extract.ts` removes what it can recognise as markup, but a
 * board is free to write its buttons as links and put them inside the very
 * block that holds the description — Paylocity does both — so the same job is
 * done again here, on paragraphs, whichever way the posting was read.
 *
 * Two passes. Paragraphs that *are* page furniture — short, and matching a
 * phrase no posting contains — are dropped wherever they occur. Then the tail
 * of the page is cut at the first paragraph that opens the footer or the
 * cookie dialog, provided the posting has had most of the page to itself by
 * then: a cookie notice can precede a posting too, and cutting there would
 * lose everything.
 */
const FURNITURE = [
  /^(?:back\s+)?apply(?:\s+now|\s+for\s+this\s+job|\s+cancel)?$/i,
  /^(?:back|cancel|close|share|print|save|save job|refer a friend|email this job|copy (?:url|link)|select all|clear|always active|skip to (?:main )?content|show more|show less|read more|view all jobs|see all jobs|back to (?:jobs|search|results|careers))$/i,
  // The account strip a portal puts above the posting, and the close button a
  // modal leaves behind as a lone letter once its markup is gone.
  /^(?:sign ?in|sign ?up|sign out|log ?in|log ?out|register|create (?:an )?account|my account|careers?|search jobs|job search|current openings)$/i,
  /^[x×✕✖]$/i,
  // The apply-on-your-phone widget a portal closes with: a QR code, which is
  // an image, and the caption and button printed beside it.
  /^scan (?:this|the) qr code\b/i,
  /^(?:download|download the (?:app|pdf)|print this job)$/i,
  /^(?:facebook|twitter|linkedin|x|email|whatsapp|copy url|copy link|share)(?:\s+(?:facebook|twitter|linkedin|x|email|whatsapp|copy url|copy link|share))+$/i,
  /^(?:join (?:our|the) talent (?:community|network|pool)|sign up for job alerts|get job alerts|create (?:a )?job alert)/i,
  /^powered by\b/i,
  /^(?:privacy|legal|terms|requirements|accessibility|cookie[s ]?\w*|artificial intelligence|sitemap|contact(?: us)?)(?:\s*[|·•]\s*(?:privacy|legal|terms|requirements|accessibility|cookie[s ]?\w*|artificial intelligence|sitemap|contact(?: us)?|policy|statement|of use|and conditions))+$/i,
  /^to manage your (?:cookie )?preferences,? click here/i,
  /^opt-out request honou?red$/i,
  /^your opt-out preference signal is honou?red/i,
  /^please switch to a supported browser/i,
  /^(?:this (?:web)?site|we|our (?:web)?site) uses? (?:our own and third-party )?cookies/i,
  /^we use (?:our own and third-party )?cookies/i,
  /^by (?:continuing to use|using|clicking)/i,
  /^if you are unable to complete this application due to a disability/i,
  /^(?:-\s*)?\[[ x]\]\s/i, // a consent checkbox, `- [x] Analytics`
  /^(?:#{1,6}\s*)?(?:required|functional|analytics|advertising|performance|targeting|strictly necessary)(?:\s+cookies)?$/i,
  /^these cookies (?:are|allow|help|enable|may|collect)/i,
  /^(?:#{1,6}\s*)?(?:cookie|consent|privacy) (?:list|preferences?|settings|choices|centre|center)$/i,
  /^(?:#{1,6}\s*)?(?:set|manage) your (?:cookie|privacy) (?:preferences|settings|choices)/i,
  /^(?:#{1,6}\s*)?(?:privacy preference cent(?:er|re)|manage consent preferences|your privacy choices)$/i,
  /^(?:#{1,6}\s*)?(?:accept|reject|decline|allow)(?:\s+all)?(?:\s+cookies)?$/i,
  /^(?:copyright\s*)?(?:©|\(c\))\s*\d{4}/i,
  /^all rights reserved\.?$/i,
  /^(?:job|requisition|req\.?|posting|reference)\s*(?:id|number|no\.?|#)\s*:?\s*[\w-]+$/i,
];

const TAIL_MARKERS = [
  // A footer that opens with its links rather than with the copyright:
  // "Terms of Use | Privacy Policy | © 2026 Paycom | All Rights Reserved."
  /(?:©|\(c\))\s*\d{4}\b.*all rights reserved/i,
  /^(?:#{1,6}\s*)?(?:set|manage) your (?:cookie|privacy) (?:preferences|settings|choices)/i,
  /^(?:#{1,6}\s*)?(?:privacy preference cent(?:er|re)|manage consent preferences|cookie (?:preferences|settings|list))$/i,
  /^(?:copyright\s*)?(?:©|\(c\))\s*\d{4}/i,
  /^we use (?:our own and third-party )?cookies/i,
  /^(?:this (?:web)?site|our (?:web)?site) uses? cookies/i,
  /^(?:#{1,6}\s*)?(?:similar|related|recommended|other) (?:jobs|roles|positions|openings)\b/i,
  /^(?:#{1,6}\s*)?(?:you (?:may|might) also (?:like|be interested in)|people also viewed)/i,
];

/** Paragraphs longer than this are prose whatever they open with. */
const MAX_FURNITURE_CHARS = 400;

/** A repeat is only furniture when it is short enough to be a label rather than a paragraph. */
const MAX_REPEAT_CHARS = 80;

/**
 * The language a portal is being read in, which its picker prints beside the
 * posting: "English (United States)". Named languages rather than any word in
 * brackets, because "Engineering (Remote)" is a role.
 */
const LANGUAGE_PICKER =
  /^(?:english|español|espanol|français|francais|deutsch|português|portugues|italiano|nederlands|polski|svenska|dansk|norsk|suomi|čeština|magyar|română|türkçe|русский|日本語|中文|한국어)(?:\s*\([^)]{2,40}\))?$/i;

/**
 * A list whose every item is a link and nothing else: a navigation rail, a
 * language menu, a row of social links. A posting's bullets are sentences —
 * one that is only a link is a button someone drew as a list item.
 */
function isLinkList(paragraph: string): boolean {
  const lines = paragraph.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  return lines.every((line) => /^[-*+]\s*(?:\[[^\]]*\]\([^)]*\)\s*)*$/.test(line));
}

/**
 * What two paragraphs have to share to count as the same one: a portal that
 * lists a job's locations under the title and again in the footer punctuates
 * the two differently, and they are the same list either way.
 */
function repeatKey(paragraph: string): string {
  return paragraph
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function stripPageFurniture(markdown: string): string {
  const paragraphs = markdown.split(/\n{2,}/);
  const kept: string[] = [];
  const seen = new Set<string>();
  const total = markdown.length;
  // Position in the *original* text, so dropped furniture still counts as
  // page that has gone by.
  let offset = 0;

  for (const paragraph of paragraphs) {
    const start = offset;
    offset += paragraph.length + 2;
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (isLinkList(trimmed)) continue;

    const bare = trimmed
      .replace(/^[*_#>\s-]+|[*_\s]+$/g, '')
      // `[Apply](https://…)` is the same furniture as the word on its own, and
      // it is how every board writes a button that is really a link.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    const short = trimmed.length <= MAX_FURNITURE_CHARS;

    if (short && start > total * 0.4 && TAIL_MARKERS.some((pattern) => pattern.test(bare) || pattern.test(trimmed))) {
      break;
    }
    if (short && (LANGUAGE_PICKER.test(bare) || FURNITURE.some((pattern) => pattern.test(bare) || pattern.test(trimmed)))) {
      continue;
    }

    // A short paragraph the page has already printed once — a portal's footer
    // repeating the locations from under the title — is the second copy, and
    // the posting said it the first time.
    const key = repeatKey(trimmed);
    if (key && trimmed.length <= MAX_REPEAT_CHARS) {
      if (seen.has(key)) continue;
      seen.add(key);
    }

    kept.push(trimmed);
  }

  return kept.join('\n\n');
}

function finishMarkdown(converted: string): MarkdownResult {
  const markdown = tidy(converted);
  if (markdown.length <= MAX_MARKDOWN_CHARS) return { markdown, truncated: false };

  // Cut at a paragraph break when there is one nearby, so the text does not
  // stop mid-sentence.
  const head = markdown.slice(0, MAX_MARKDOWN_CHARS);
  const boundary = head.lastIndexOf('\n\n');
  const cut = boundary > MAX_MARKDOWN_CHARS * 0.8 ? head.slice(0, boundary) : head;

  return { markdown: `${cut.trimEnd()}\n\n_[Description truncated — open the job URL for the rest.]_`, truncated: true };
}
