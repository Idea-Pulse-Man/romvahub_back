/**
 * DOCX → PDF without Microsoft Word, for hosts that do not have it (Vercel).
 *
 * `mammoth`, the earlier fallback, extracts *content*: it drops fonts, colours,
 * tab stops, borders and spacing by design, so the PDF looked nothing like the
 * Word file. Here the document is laid out by `docx-preview` — which reads the
 * template's styles, numbering, tab stops and page setup — inside the same
 * headless Chromium that prints it.
 *
 * What it does not draw is patched before rendering, on a copy used only for
 * the PDF: horizontal line shapes (the rule under each section heading in the
 * Maker templates) become paragraph bottom borders.
 *
 * The browser-side scripts and the fonts are read from `node_modules`, so the
 * serverless function must ship them — see `includeFiles` in vercel.json.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { logger } from '../../logger.js';
import { CARLITO_FACES } from '../template/font-data.js';
import { withPage } from '../template/pdf.js';

const require = createRequire(import.meta.url);

/** Word font names → the embedded face that stands in for them. */
const FONT_FAMILIES: Record<string, string[]> = {
  carlito: ['Calibri', 'Calibri Light', 'Carlito'],
  arimo: ['Arial', 'Arial Black', 'Helvetica', 'Arimo'],
  roboto: ['Roboto'],
};

const FACES = [
  [400, 'normal'],
  [700, 'normal'],
  [400, 'italic'],
  [700, 'italic'],
] as const;

/**
 * Fixes to docx-preview 0.4.x, applied to its source as it is loaded. Each
 * `find` must match exactly — `patchDocxPreview` throws otherwise, so an
 * upgrade that moves the code fails loudly (and the PDF falls back to mammoth)
 * instead of quietly misplacing every tab.
 */
const DOCX_PREVIEW_PATCHES: { why: string; find: string; replace: string }[] = [
  {
    why:
      'A tab is first drawn as an em space, measured, then replaced by a narrower ' +
      'no-break space plus word-spacing — right and centre tabs lose the difference ' +
      '(the dates stopped ~10px short of the margin). Size the span exactly instead.',
    find: `        elem.innerHTML = "&nbsp;";
        elem.style.textDecoration = "inherit";
        elem.style.wordSpacing = \`\${width.toFixed(0)}pt\`;`,
    replace: `        if (tab.style == "right" || tab.style == "center")
            width += ebb.width * pixelToPoint;
        elem.innerHTML = "&nbsp;";
        elem.style.textDecoration = "inherit";
        elem.style.display = "inline-block";
        elem.style.width = \`\${Math.max(0, width)}pt\`;`,
  },
  {
    why:
      'Tab stops are laid out on a 500ms timer, before or after the fonts load. ' +
      'Expose it instead, so the page runs it once fonts and print styles are in.',
    find: `            setTimeout(() => {
                const pixelToPoint = computePixelToPoint();
                for (let tab of this.currentTabs) {
                    updateTabStop(tab.span, tab.stops, this.defaultTabSize, pixelToPoint);
                }
            }, 500);`,
    replace: `            window.__docxRefreshTabStops = () => {
                const pixelToPoint = computePixelToPoint();
                for (let tab of this.currentTabs) {
                    updateTabStop(tab.span, tab.stops, this.defaultTabSize, pixelToPoint);
                }
            };`,
  },
];

export function patchDocxPreview(source: string): string {
  return DOCX_PREVIEW_PATCHES.reduce((code, { why, find, replace }) => {
    if (!code.includes(find)) throw new Error(`docx-preview patch no longer applies: ${why}`);
    return code.replace(find, replace);
  }, source.replace(/\r\n/g, '\n'));
}

interface PreviewAssets {
  css: string;
  scripts: string[];
}

let assets: Promise<PreviewAssets> | undefined;

function packageDir(entry: string): string {
  return path.dirname(require.resolve(entry));
}

async function fontsourceFaces(pkg: 'roboto' | 'arimo'): Promise<{ base64: string; weight: number; style: string }[]> {
  const dir = path.join(packageDir(`@fontsource/${pkg}/LICENSE`), 'files');
  return Promise.all(
    FACES.map(async ([weight, style]) => ({
      weight,
      style,
      base64: (await readFile(path.join(dir, `${pkg}-latin-${weight}-${style}.woff2`))).toString('base64'),
    })),
  );
}

async function loadAssets(): Promise<PreviewAssets> {
  const faces = {
    carlito: CARLITO_FACES,
    arimo: await fontsourceFaces('arimo'),
    roboto: await fontsourceFaces('roboto'),
  };
  const css = Object.entries(faces)
    .flatMap(([key, list]) =>
      FONT_FAMILIES[key]!.flatMap(family =>
        list.map(
          ({ base64, weight, style }) =>
            `@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};font-display:block;` +
            `src:url(data:font/woff2;base64,${base64}) format("woff2")}`,
        ),
      ),
    )
    .join('\n');

  const scripts = await Promise.all([
    readFile(require.resolve('jszip/dist/jszip.min.js'), 'utf8'),
    // The readable build, because it is patched by exact text.
    readFile(path.join(packageDir('docx-preview'), 'docx-preview.js'), 'utf8').then(patchDocxPreview),
  ]);
  return { css, scripts };
}

function previewAssets(): Promise<PreviewAssets> {
  assets ??= loadAssets().catch(error => {
    assets = undefined;
    throw error;
  });
  return assets;
}

// ---------------------------------------------------------------------------
// Line shapes → paragraph borders
// ---------------------------------------------------------------------------

const EMU_PER_POINT = 12700;

function children(parent: Element, name: string): Element[] {
  return Array.from(parent.childNodes).filter(
    (node): node is Element => node.nodeType === 1 && (node as Element).nodeName === name,
  );
}

function first(root: Element, name: string): Element | undefined {
  return root.getElementsByTagName(name)[0] ?? undefined;
}

function ancestor(node: Element, name: string): Element | undefined {
  let current = node.parentNode as Element | null;
  while (current && current.nodeType === 1) {
    if (current.nodeName === name) return current;
    current = current.parentNode as Element | null;
  }
  return undefined;
}

interface Theme {
  colors: Record<string, string>;
  /** Line widths of the theme's line styles, in EMU, by `lnRef` index. */
  lineWidths: number[];
}

function readTheme(xml: string | undefined): Theme {
  const theme: Theme = { colors: {}, lineWidths: [] };
  if (!xml) return theme;
  const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
  if (!root) return theme;

  const scheme = first(root, 'a:clrScheme');
  for (const node of Array.from(scheme?.childNodes ?? [])) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const color = first(el, 'a:srgbClr')?.getAttribute('val') ?? first(el, 'a:sysClr')?.getAttribute('lastClr');
    if (color) theme.colors[el.nodeName.replace(/^a:/, '')] = color;
  }
  const lines = first(root, 'a:lnStyleLst');
  if (lines) theme.lineWidths = children(lines, 'a:ln').map(ln => Number(ln.getAttribute('w')) || 0);
  return theme;
}

const SCHEME_ALIASES: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };

function colorOf(fill: Element | undefined, theme: Theme): string | undefined {
  if (!fill) return undefined;
  const rgb = first(fill, 'a:srgbClr')?.getAttribute('val');
  if (rgb) return rgb;
  const scheme = first(fill, 'a:schemeClr')?.getAttribute('val');
  return scheme ? theme.colors[SCHEME_ALIASES[scheme] ?? scheme] : undefined;
}

/** The border a horizontal line drawing stands for, or null for any other drawing. */
function lineBorder(drawing: Element, theme: Theme): { color: string; eighths: number } | null {
  const geometry = first(drawing, 'a:prstGeom')?.getAttribute('prst');
  if (geometry !== 'line' && geometry !== 'straightConnector1') return null;
  const extent = first(drawing, 'wp:extent');
  const cx = Number(extent?.getAttribute('cx')) || 0;
  const cy = Number(extent?.getAttribute('cy')) || 0;
  if (!cx || cy > cx / 20) return null;

  const ln = first(drawing, 'a:ln');
  const lnRef = first(drawing, 'a:lnRef');
  const color =
    colorOf(ln ? first(ln, 'a:solidFill') : undefined, theme) ??
    colorOf(lnRef, theme) ??
    '000000';
  const widthEmu =
    Number(ln?.getAttribute('w')) ||
    theme.lineWidths[(Number(lnRef?.getAttribute('idx')) || 1) - 1] ||
    EMU_PER_POINT;
  const eighths = Math.min(96, Math.max(2, Math.round((widthEmu / EMU_PER_POINT) * 8)));
  return { color, eighths };
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Zero-width text that marks an empty paragraph's mark run. */
const EMPTY_MARK = '​';

/** Bookmark names that carry a paragraph's own keep settings into the page. */
const KEEP_NEXT_MARK = '__keep_next_';
const KEEP_LINES_MARK = '__keep_lines_';

/**
 * docx-preview puts a run's East Asian font in its font list, so a run that
 * names only that (Cormorant, say) renders in it — or, missing, in the
 * browser's serif — where Word uses the style's Latin font. Resumes are Latin
 * text: drop the East Asian and complex-script slots so the Latin font wins.
 */
function latinFontsOnly(root: Element): void {
  for (const fonts of Array.from(root.getElementsByTagName('w:rFonts'))) {
    for (const name of ['w:eastAsia', 'w:eastAsiaTheme', 'w:cs', 'w:cstheme']) fonts.removeAttribute(name);
  }
}

/** Fonts whose bullets Word stores as Private Use Area code points (U+F0xx). */
const SYMBOL_FONTS = /^(symbol|wingdings( [23])?|webdings)$/i;
const PRIVATE_USE = /[-]/;

/**
 * Word's default bullet is U+F0B7 in Symbol (U+F0A7 in Wingdings for the
 * square, and so on): Private Use Area code points that only draw in that
 * font. Headless Chromium has no Symbol, so the marker printed as nothing —
 * the indent was there, the dot was not. Replace such a level's text with a
 * real bullet and drop the symbol font, so it draws in the paragraph's
 * (embedded) font, which has U+2022.
 */
function unicodeBullets(root: Element): void {
  for (const level of Array.from(root.getElementsByTagName('w:lvl'))) {
    const text = children(level, 'w:lvlText')[0];
    const value = text?.getAttribute('w:val') ?? '';
    if (!text || !PRIVATE_USE.test(value)) continue;
    const rPr = children(level, 'w:rPr')[0];
    const fonts = rPr && children(rPr, 'w:rFonts')[0];
    const named = fonts ? ['w:ascii', 'w:hAnsi'].map(name => fonts.getAttribute(name) ?? '') : [];
    if (!named.some(name => SYMBOL_FONTS.test(name))) continue;
    text.setAttribute('w:val', value.replace(new RegExp(PRIVATE_USE.source, 'g'), '•'));
    rPr!.removeChild(fonts!);
  }
}

function pPrOf(paragraph: Element): Element {
  let pPr = children(paragraph, 'w:pPr')[0];
  if (!pPr) {
    pPr = paragraph.ownerDocument!.createElementNS(W_NS, 'w:pPr');
    paragraph.insertBefore(pPr, paragraph.firstChild);
  }
  return pPr;
}

/**
 * Word draws the inline line at the top of its (tiny) paragraph, right under
 * the heading — so a top border; a bottom one sits a whole empty line lower.
 */
function addTopBorder(paragraph: Element, { color, eighths }: { color: string; eighths: number }): void {
  const doc = paragraph.ownerDocument!;
  const pPr = pPrOf(paragraph);
  let pBdr = children(pPr, 'w:pBdr')[0];
  if (!pBdr) {
    pBdr = doc.createElementNS(W_NS, 'w:pBdr');
    pPr.appendChild(pBdr);
  }
  children(pBdr, 'w:top').forEach(old => pBdr!.removeChild(old));
  const top = doc.createElementNS(W_NS, 'w:top');
  top.setAttribute('w:val', 'single');
  top.setAttribute('w:sz', String(eighths));
  top.setAttribute('w:space', '0');
  top.setAttribute('w:color', color);
  pBdr.appendChild(top);
}

/** `w:keepNext`, `w:default` and friends: on unless the value says otherwise. */
function isOn(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === '' || !/^(0|false|off)$/i.test(value);
}

/** The class docx-preview gives a style (`processStyleName` + `escapeClassName`). */
function styleClass(styleId: string): string {
  return `docx_${styleId.replace(/[ .]+/g, '-').replace(/[&]+/g, 'and').toLowerCase()}`;
}

interface StyleFacts {
  /** The paragraph style of a paragraph without `w:pStyle`. */
  defaultParagraph?: string;
  keepWithNext: string[];
  keepTogether: string[];
  /** Style ids with "Don't add space between paragraphs of the same style". */
  contextualSpacing: Set<string>;
}

function readStyles(xml: string | undefined): StyleFacts {
  const facts: StyleFacts = { keepWithNext: [], keepTogether: [], contextualSpacing: new Set() };
  const root = xml ? new DOMParser().parseFromString(xml, 'application/xml').documentElement : null;
  if (!root) return facts;

  type Keep = { basedOn?: string; next?: boolean; lines?: boolean; contextual?: boolean };
  const styles = new Map<string, Keep>();
  for (const style of Array.from(root.getElementsByTagName('w:style'))) {
    const id = style.getAttribute('w:styleId');
    if (style.getAttribute('w:type') !== 'paragraph' || !id) continue;
    if (style.hasAttribute('w:default') && isOn(style.getAttribute('w:default'))) {
      facts.defaultParagraph ??= id;
    }
    const pPr = children(style, 'w:pPr')[0];
    const keepNext = pPr && children(pPr, 'w:keepNext')[0];
    const keepLines = pPr && children(pPr, 'w:keepLines')[0];
    const contextual = pPr && children(pPr, 'w:contextualSpacing')[0];
    styles.set(id, {
      basedOn: children(style, 'w:basedOn')[0]?.getAttribute('w:val') ?? undefined,
      next: keepNext ? isOn(keepNext.getAttribute('w:val')) : undefined,
      lines: keepLines ? isOn(keepLines.getAttribute('w:val')) : undefined,
      contextual: contextual ? isOn(contextual.getAttribute('w:val')) : undefined,
    });
  }

  const resolve = (id: string, key: 'next' | 'lines' | 'contextual', seen = new Set<string>()): boolean => {
    const style = styles.get(id);
    if (!style || seen.has(id)) return false;
    seen.add(id);
    const own = style[key];
    if (own !== undefined) return own;
    return style.basedOn ? resolve(style.basedOn, key, seen) : false;
  };
  for (const id of styles.keys()) {
    if (resolve(id, 'next')) facts.keepWithNext.push(styleClass(id));
    if (resolve(id, 'lines')) facts.keepTogether.push(styleClass(id));
    if (resolve(id, 'contextual')) facts.contextualSpacing.add(id);
  }
  return facts;
}

function setSpacing(paragraph: Element, side: 'w:before' | 'w:after'): void {
  const pPr = pPrOf(paragraph);
  let spacing = children(pPr, 'w:spacing')[0];
  if (!spacing) {
    spacing = paragraph.ownerDocument!.createElementNS(W_NS, 'w:spacing');
    pPr.appendChild(spacing);
  }
  spacing.setAttribute(side, '0');
}

/** Runs after every paragraph has an explicit `w:pStyle`. */
function applyContextualSpacing(root: Element, contextualStyles: Set<string>): void {
  for (const paragraph of Array.from(root.getElementsByTagName('w:p'))) {
    let next = paragraph.nextSibling;
    while (next && next.nodeType !== 1) next = next.nextSibling;
    if (!next || next.nodeName !== 'w:p') continue;
    const styleOf = (p: Element) => {
      const pPr = children(p, 'w:pPr')[0];
      return pPr && children(pPr, 'w:pStyle')[0]?.getAttribute('w:val');
    };
    const style = styleOf(paragraph);
    if (!style || style !== styleOf(next as Element)) continue;
    const own = children(pPrOf(paragraph), 'w:contextualSpacing')[0];
    if (own ? !isOn(own.getAttribute('w:val')) : !contextualStyles.has(style)) continue;
    setSpacing(paragraph, 'w:after');
    setSpacing(next as Element, 'w:before');
  }
}

export interface PreviewDocument {
  /** The copy of the document docx-preview is given; the download is untouched. */
  docx: Buffer;
  /** docx-preview classes of styles with "Keep with next", which it ignores. */
  keepWithNext: string[];
  /** …and with "Keep lines together". */
  keepTogether: string[];
}

/**
 * Patches, on a copy, what docx-preview would otherwise get wrong:
 * - horizontal line shapes (the rule under each section heading) become
 *   paragraph borders — it does not draw shapes;
 * - paragraphs with no `w:pStyle` are given the default paragraph style
 *   explicitly — it styles them from the document defaults instead (in the
 *   Maker templates: grey 11pt rather than Normal's black 10pt);
 * - "Don't add space between paragraphs of the same style" is applied as
 *   zero spacing between them — it ignores it (bullet lists ran long);
 * - trailing spaces are trimmed — Word ignores them when aligning;
 * - Symbol/Wingdings bullets become U+2022 — Chromium has no Symbol font.
 */
export async function prepareForPreview(docx: Buffer): Promise<PreviewDocument> {
  const zip = await JSZip.loadAsync(docx);
  const theme = readTheme(await zip.file('word/theme/theme1.xml')?.async('string'));
  const styles = readStyles(await zip.file('word/styles.xml')?.async('string'));
  const parts = Object.keys(zip.files).filter(name =>
    /^word\/(document|header\d*|footer\d*)\.xml$/i.test(name),
  );

  let bookmarkId = 900000;

  for (const part of ['word/styles.xml', 'word/numbering.xml']) {
    const xml = await zip.file(part)?.async('string');
    if (!xml) continue;
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    if (!dom.documentElement) continue;
    latinFontsOnly(dom.documentElement);
    if (part === 'word/numbering.xml') unicodeBullets(dom.documentElement);
    zip.file(part, new XMLSerializer().serializeToString(dom));
  }

  for (const part of parts) {
    const dom = new DOMParser().parseFromString(await zip.file(part)!.async('string'), 'application/xml');
    if (!dom.documentElement) continue;

    for (const drawing of Array.from(dom.getElementsByTagName('w:drawing'))) {
      const border = lineBorder(drawing, theme);
      const run = ancestor(drawing, 'w:r');
      const paragraph = run && ancestor(run, 'w:p');
      if (!border || !run || !paragraph) continue;
      addTopBorder(paragraph, border);
      run.parentNode?.removeChild(run);
    }

    // An empty paragraph is as tall as its paragraph mark's font (5pt for the
    // spacer under each heading); docx-preview sizes it from the paragraph's
    // text style instead. Give it a zero-width run in the mark's formatting,
    // which the page then sizes the paragraph by (see `EMPTY_MARK`).
    for (const paragraph of Array.from(dom.getElementsByTagName('w:p'))) {
      if (paragraph.getElementsByTagName('w:t').length || paragraph.getElementsByTagName('w:drawing').length) continue;
      const markProps = children(pPrOf(paragraph), 'w:rPr')[0];
      if (!markProps) continue;
      const run = dom.createElementNS(W_NS, 'w:r');
      run.appendChild(markProps.cloneNode(true));
      const text = dom.createElementNS(W_NS, 'w:t');
      text.textContent = EMPTY_MARK;
      run.appendChild(text);
      paragraph.appendChild(run);
    }

    // Word ignores a paragraph's trailing spaces when aligning it; docx-preview
    // counts them, so right-aligned dates would stop short of the margin.
    for (const paragraph of Array.from(dom.getElementsByTagName('w:p'))) {
      const texts = Array.from(paragraph.getElementsByTagName('w:t'));
      for (let i = texts.length - 1; i >= 0; i -= 1) {
        const text = texts[i]!;
        const trimmed = (text.textContent ?? '').replace(/\s+$/, '');
        text.textContent = trimmed;
        if (trimmed) break;
      }
    }

    if (styles.defaultParagraph) {
      for (const paragraph of Array.from(dom.getElementsByTagName('w:p'))) {
        const pPr = pPrOf(paragraph);
        if (children(pPr, 'w:pStyle').length) continue;
        const pStyle = dom.createElementNS(W_NS, 'w:pStyle');
        pStyle.setAttribute('w:val', styles.defaultParagraph);
        pPr.insertBefore(pStyle, pPr.firstChild);
      }
    }
    applyContextualSpacing(dom.documentElement, styles.contextualSpacing);
    latinFontsOnly(dom.documentElement);

    // Keep settings on the paragraph itself (not its style) reach the page as
    // bookmarks, which docx-preview renders as `<span id>`.
    for (const paragraph of Array.from(dom.getElementsByTagName('w:p'))) {
      const pPr = pPrOf(paragraph);
      for (const [name, mark] of [['w:keepNext', KEEP_NEXT_MARK], ['w:keepLines', KEEP_LINES_MARK]] as const) {
        const own = children(pPr, name)[0];
        if (!own || !isOn(own.getAttribute('w:val'))) continue;
        const bookmark = dom.createElementNS(W_NS, 'w:bookmarkStart');
        bookmarkId += 1;
        bookmark.setAttribute('w:id', String(bookmarkId));
        bookmark.setAttribute('w:name', mark + bookmarkId);
        paragraph.insertBefore(bookmark, pPr.nextSibling);
      }
    }
    zip.file(part, new XMLSerializer().serializeToString(dom));
  }

  return {
    docx: Buffer.from(await zip.generateAsync({ type: 'nodebuffer' })),
    keepWithNext: styles.keepWithNext,
    keepTogether: styles.keepTogether,
  };
}

// ---------------------------------------------------------------------------
// Render + print
// ---------------------------------------------------------------------------

/**
 * Runs in the page (as source text — this package compiles without the DOM
 * types). Renders the document, turns the first page's padding into `@page`
 * margins so Chromium paginates long Resumes with Word's margins, applies the
 * keep rules, and only then — fonts loaded, final widths set — lays out the tab
 * stops (see `DOCX_PREVIEW_PATCHES`).
 */
const RENDER_IN_PAGE = `async ({ base64, keepWithNext, keepTogether, emptyMark, keepNextMark, keepLinesMark }) => {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const container = document.getElementById('doc');
  await window.docx.renderAsync(new Blob([bytes]), container, null, {
    inWrapper: false,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    experimental: true,
    useBase64URL: true,
    renderComments: false,
  });

  const section = container.querySelector('section.docx');
  if (!section) throw new Error('docx-preview rendered no page');
  const style = getComputedStyle(section);
  const px = value => parseFloat(value) || 0;
  const page = {
    width: px(style.width),
    height: px(style.minHeight) || 1056,
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };

  const selector = list => list.map(name => 'p.' + CSS.escape(name)).join(',');
  const print = document.createElement('style');
  print.textContent =
    '@page{size:' + page.width + 'px ' + page.height + 'px;margin:' +
      page.top + 'px ' + page.right + 'px ' + page.bottom + 'px ' + page.left + 'px}' +
    'section.docx{padding:0!important;margin:0!important;box-shadow:none!important;' +
      'min-height:0!important;height:auto!important;width:' + (page.width - page.left - page.right) + 'px!important}' +
    // Each section is a page in Word; later ones start on a new page.
    'section.docx+section.docx{break-before:page}' +
    'section.docx>header,section.docx>footer{margin:0!important}' +
    (keepTogether.length ? selector(keepTogether) + '{break-inside:avoid}' : '');
  document.head.appendChild(print);

  // A heading keeps with what follows it, through any empty spacer paragraphs
  // (such as the one carrying the rule under it), which must not end a page.
  const marked = mark => [...container.querySelectorAll('span[id^="' + mark + '"]')]
    .map(span => span.closest('p'))
    .filter(Boolean);
  for (const p of marked(keepLinesMark)) p.style.breakInside = 'avoid';
  const keepNext = new Set([
    ...(keepWithNext.length ? container.querySelectorAll(selector(keepWithNext)) : []),
    ...marked(keepNextMark),
  ]);
  {
    for (const p of keepNext) {
      let current = p;
      while (current) {
        current.style.breakAfter = 'avoid';
        const next = current.nextElementSibling;
        current = next && next.tagName === 'P' && !next.textContent.trim() ? next : null;
      }
    }
  }

  // A list marker is followed by a tab to the hanging indent; docx-preview
  // writes the tab into ::before, where it collapses to a space. Give the marker
  // the indent's width instead, so the text lines up with its wrapped lines.
  const markers = new Map();
  for (const p of container.querySelectorAll('p[class*="docx-num-"]')) {
    const name = [...p.classList].find(c => /^docx-num-\\d+-\\d+$/.test(c));
    const hanging = -parseFloat(getComputedStyle(p).textIndent);
    if (name && hanging > 0 && !markers.has(name)) markers.set(name, hanging);
  }
  for (const [name, hanging] of markers) {
    print.textContent += 'p.' + name + '::before{display:inline-block;min-width:' + hanging + 'px;' +
      'text-indent:0;white-space:nowrap}';
  }

  // Word sizes a line by the text on it. CSS also reserves a line for the
  // paragraph's own font (its style's default, which can be larger — 12pt Times
  // under 10pt Roboto bullets), so give the paragraph its smallest text size.
  // Empty paragraphs are sized by their mark run alone.
  for (const p of container.querySelectorAll('p')) {
    const sizes = [...p.querySelectorAll('span')]
      .filter(span => span.textContent && !span.classList.contains('docx-tab-stop'))
      .map(span => parseFloat(getComputedStyle(span).fontSize))
      .filter(size => size > 0);
    if (!sizes.length) continue;
    p.style.fontSize = Math.min(...sizes) + 'px';
    if (p.textContent === emptyMark) p.style.minHeight = '0';
  }

  await document.fonts.ready;

  // Word's "Multiple" line spacing (1.15, say) multiplies the font's own line
  // height (ascent + descent + gap: 1.22em for Calibri); a unitless CSS
  // line-height multiplies the font size. Scale each such value by the font's
  // measured normal line height, or every multi-line paragraph runs short.
  // By style class; '' is the document default (docx-preview's '.docx p').
  const numericLineHeights = new Map();
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      const value = rule.style && rule.style.lineHeight;
      if (!rule.selectorText || !/^[\\d.]+$/.test(value || '')) continue;
      const selector = rule.selectorText.trim();
      const match = /^(?:p)?\\.(docx_[\\w-]+)$/.exec(selector);
      if (match) numericLineHeights.set(match[1], parseFloat(value));
      else if (selector === '.docx p') numericLineHeights.set('', parseFloat(value));
    }
  }
  const normalLineHeight = new Map();
  const fontFactor = family => {
    // Word's single line for the template fonts (their hhea metrics). The
    // stand-ins can report other values — Roboto's 1.2 is its Windows metric.
    const known = { calibri: 1.221, 'calibri light': 1.221, carlito: 1.221, arial: 1.15, arimo: 1.15, roboto: 1.172 };
    const first = family.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (known[first]) return known[first];
    if (!normalLineHeight.has(family)) {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;font-size:100px;font-family:' + family;
      probe.textContent = 'Hg';
      document.body.appendChild(probe);
      normalLineHeight.set(family, probe.getBoundingClientRect().height / 100 || 1);
      probe.remove();
    }
    return normalLineHeight.get(family);
  };
  for (const p of container.querySelectorAll('p')) {
    let multiple = /^[\\d.]+$/.test(p.style.lineHeight) ? parseFloat(p.style.lineHeight) : undefined;
    if (multiple === undefined) {
      for (const name of p.classList) if (numericLineHeights.has(name)) multiple = numericLineHeights.get(name);
    }
    multiple ??= numericLineHeights.get('');
    if (!multiple) continue;
    const text = p.querySelector('span') || p;
    p.style.lineHeight = String(multiple * fontFactor(getComputedStyle(text).fontFamily));
  }

  if (!window.__docxRefreshTabStops) throw new Error('docx-preview tab stop patch missing');
  window.__docxRefreshTabStops();
  return page;
}`;

export async function docxToPdfViaPreview(docx: Buffer): Promise<Buffer> {
  const started = Date.now();
  const [{ css, scripts }, prepared] = await Promise.all([previewAssets(), prepareForPreview(docx)]);

  return withPage(async page => {
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;padding:0;background:#fff}
body{font-family:Arimo,sans-serif}
</style></head><body><div id="doc"></div></body></html>`,
      { waitUntil: 'load' },
    );
    for (const content of scripts) await page.addScriptTag({ content });

    const input = {
      base64: prepared.docx.toString('base64'),
      keepWithNext: prepared.keepWithNext,
      keepTogether: prepared.keepTogether,
      emptyMark: EMPTY_MARK,
      keepNextMark: KEEP_NEXT_MARK,
      keepLinesMark: KEEP_LINES_MARK,
    };
    const setup: unknown = await page.evaluate(`(${RENDER_IN_PAGE})(${JSON.stringify(input)})`);

    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true, tagged: true });
    logger.debug(
      { ms: Date.now() - started, bytes: pdf.byteLength, page: setup },
      'DOCX printed to PDF via docx-preview',
    );
    return Buffer.from(pdf);
  });
}
