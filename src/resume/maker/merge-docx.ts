/**
 * OpenXML DOCX mail-merge using JSZip + @xmldom/xmldom.
 * Ported from ResumeMaker.Services.ResumeService.MergeTemplate and helpers.
 */

import JSZip from 'jszip';
import {
  DOMParser,
  XMLSerializer,
  type Document,
  type Element,
  type Node,
} from '@xmldom/xmldom';
import { scrubDocumentProperties, type DocumentProperties } from './docx-properties.js';
import { getPlaceholder, normalizeNewlines } from './placeholders.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const PLACEHOLDER_REGEX = /<\s*([^<>]+?)\s*>/g;
const ANY_SKILL_GROUP_TOKEN = /<\s*Skill-Groups?(?:-\d+)?\s*>/gi;
const ANY_SKILLS_VALUE_TOKEN = /<\s*Skills(?:-\d+)?\s*>/gi;
/**
 * Bold spans in a value: Resume Maker's `[text][highlight]`, or Markdown's
 * `**text**` — the form AI-written bullets and pasted Resume JSON use.
 */
const HIGHLIGHT_REGEX = /\[(.*?)\]\[highlight\]|\*\*([^*\n]+?)\*\*/gs;

type FormattedTextSegment = { text: string; isHighlighted: boolean };

function localName(node: Node): string {
  if (node.nodeType !== 1) {
    return '';
  }
  const el = node as Element;
  if (el.localName) {
    return el.localName;
  }
  const raw = el.nodeName;
  const colon = raw.indexOf(':');
  return colon >= 0 ? raw.slice(colon + 1) : raw;
}

function isElement(node: Node | null | undefined): node is Element {
  return !!node && node.nodeType === 1;
}

function createW(doc: Document, name: string): Element {
  return doc.createElementNS(W_NS, `w:${name}`);
}

function directChildren(parent: Element, name: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const child = parent.childNodes.item(i);
    if (isElement(child) && localName(child) === name) {
      out.push(child);
    }
  }
  return out;
}

function descendants(root: Element, name: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Node): void => {
    if (!isElement(node)) {
      return;
    }
    if (localName(node) === name) {
      out.push(node);
    }
    for (let i = 0; i < node.childNodes.length; i += 1) {
      const child = node.childNodes.item(i);
      if (child) {
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

function insertAfter(ref: Node, node: Node): void {
  const parent = ref.parentNode;
  if (!parent) {
    return;
  }
  if (ref.nextSibling) {
    parent.insertBefore(node, ref.nextSibling);
  } else {
    parent.appendChild(node);
  }
}

function removeNode(node: Node): void {
  node.parentNode?.removeChild(node);
}

function getTextContent(textNode: Element): string {
  return textNode.textContent ?? '';
}

function getParagraphText(paragraph: Element): string {
  let first: string | null = null;
  let builder: string | null = null;
  for (const text of descendants(paragraph, 't')) {
    const part = getTextContent(text);
    if (first === null) {
      first = part;
      continue;
    }
    builder ??= first;
    builder += part;
  }
  return builder ?? first ?? '';
}

function ancestorRun(node: Node): Element | null {
  let cur: Node | null = node.parentNode;
  while (cur) {
    if (isElement(cur) && localName(cur) === 'r') {
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

function cloneRunProperties(rPr: Element | null | undefined): Element | null {
  if (!rPr) {
    return null;
  }
  return rPr.cloneNode(true) as Element;
}

function removeBoldChildren(rPr: Element): void {
  for (const name of ['b', 'bCs'] as const) {
    for (const child of directChildren(rPr, name)) {
      removeNode(child);
    }
  }
}

function hasChildNamed(parent: Element, name: string): boolean {
  return directChildren(parent, name).length > 0;
}

function createRun(
  doc: Document,
  properties: Element | null,
  text: string,
): Element {
  const run = createW(doc, 'r');
  if (properties) {
    run.appendChild(properties.cloneNode(true));
  }
  const t = createW(doc, 't');
  t.setAttribute('xml:space', 'preserve');
  t.appendChild(doc.createTextNode(text));
  run.appendChild(t);
  return run;
}

function createBreakRun(doc: Document, properties: Element | null): Element {
  const run = createW(doc, 'r');
  if (properties) {
    run.appendChild(properties.cloneNode(true));
  }
  run.appendChild(createW(doc, 'br'));
  return run;
}

function parseFormattedSegments(text: string): FormattedTextSegment[] {
  const segments: FormattedTextSegment[] = [];
  let lastIndex = 0;
  HIGHLIGHT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HIGHLIGHT_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        text: text.slice(lastIndex, match.index),
        isHighlighted: false,
      });
    }
    segments.push({
      text: match[1] ?? match[2] ?? '',
      isHighlighted: true,
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isHighlighted: false });
  }
  if (segments.length === 0) {
    segments.push({ text, isHighlighted: false });
  }
  return segments;
}

function createRunsForSingleLine(
  doc: Document,
  baseProperties: Element | null,
  text: string,
): Element[] {
  if (!text.includes('[highlight]') && !text.includes('**')) {
    return [createRun(doc, baseProperties, text)];
  }

  const segments = parseFormattedSegments(text);
  if (segments.length === 0) {
    return [createRun(doc, baseProperties, '')];
  }

  const runs: Element[] = [];
  for (const segment of segments) {
    if (segment.text.length === 0) {
      continue;
    }
    let properties = cloneRunProperties(baseProperties);
    if (segment.isHighlighted) {
      properties ??= createW(doc, 'rPr');
      if (!hasChildNamed(properties, 'b')) {
        properties.appendChild(createW(doc, 'b'));
      }
      if (!hasChildNamed(properties, 'bCs')) {
        properties.appendChild(createW(doc, 'bCs'));
      }
    }
    runs.push(createRun(doc, properties, segment.text));
  }
  return runs;
}

function createRunsFromFormattedText(
  doc: Document,
  baseProperties: Element | null,
  text: string,
): Element[] {
  const normalized = normalizeNewlines(text);
  if (!normalized.includes('\n')) {
    return createRunsForSingleLine(doc, baseProperties, normalized);
  }

  const runs: Element[] = [];
  const lines = normalized.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) {
      runs.push(createBreakRun(doc, baseProperties));
    }
    runs.push(...createRunsForSingleLine(doc, baseProperties, lines[i] ?? ''));
  }
  return runs;
}

function replaceAcrossRuns(
  paragraph: Element,
  startTextNode: Element,
  endTextNode: Element,
  prefix: string,
  replacement: string,
  suffix: string,
): void {
  const doc = paragraph.ownerDocument;
  if (!doc) {
    return;
  }

  const startRun = ancestorRun(startTextNode);
  const endRun = ancestorRun(endTextNode);
  if (!startRun || !endRun) {
    return;
  }

  const runs = directChildren(paragraph, 'r');
  const startRunIndex = runs.indexOf(startRun);
  const endRunIndex = runs.indexOf(endRun);
  if (startRunIndex < 0 || endRunIndex < 0 || endRunIndex < startRunIndex) {
    return;
  }

  const startProps = cloneRunProperties(directChildren(startRun, 'rPr')[0]);
  const endProps = cloneRunProperties(directChildren(endRun, 'rPr')[0]);
  const replacementProps = cloneRunProperties(directChildren(startRun, 'rPr')[0]);

  const insertedRuns: Element[] = [];
  if (prefix) {
    insertedRuns.push(createRun(doc, startProps, prefix));
  }
  insertedRuns.push(
    ...createRunsFromFormattedText(doc, replacementProps, replacement),
  );
  if (suffix) {
    insertedRuns.push(createRun(doc, endProps, suffix));
  }

  for (const run of insertedRuns) {
    paragraph.insertBefore(run, startRun);
  }

  for (let i = startRunIndex; i <= endRunIndex; i += 1) {
    const run = runs[i];
    if (run) {
      removeNode(run);
    }
  }
}

/**
 * Port of C# ReplaceRangeAcrossNodes. For multi-run spans we take the end-node
 * suffix (C# returns on the start-node iteration with that node's local suffix,
 * which would drop trailing text; end-node suffix is the correct intent).
 */
function replaceRangeAcrossNodes(
  paragraph: Element,
  textNodes: Element[],
  startIndex: number,
  length: number,
  replacement: string,
): void {
  if (length <= 0) {
    return;
  }

  const endIndex = startIndex + length;
  let cumulative = 0;
  let startNodeIndex = -1;
  let endNodeIndex = -1;

  for (let i = 0; i < textNodes.length; i += 1) {
    const nodeLength = getTextContent(textNodes[i]!).length;
    const nodeStart = cumulative;
    const nodeEnd = cumulative + nodeLength;

    if (startNodeIndex < 0 && startIndex >= nodeStart && startIndex < nodeEnd) {
      startNodeIndex = i;
    }
    if (endNodeIndex < 0 && endIndex > nodeStart && endIndex <= nodeEnd) {
      endNodeIndex = i;
    }
    cumulative += nodeLength;
  }

  if (startNodeIndex < 0 || endNodeIndex < 0) {
    return;
  }

  cumulative = 0;
  for (let i = 0; i < textNodes.length; i += 1) {
    const nodeLength = getTextContent(textNodes[i]!).length;
    const nodeStart = cumulative;
    cumulative += nodeLength;

    if (i < startNodeIndex || i > endNodeIndex) {
      continue;
    }

    let localStart = Math.max(startIndex - nodeStart, 0);
    let localEnd = Math.min(endIndex - nodeStart, nodeLength);
    if (localStart > nodeLength) {
      localStart = nodeLength;
    }
    if (localEnd < 0) {
      localEnd = 0;
    }

    const text = getTextContent(textNodes[i]!);
    const prefix = text.slice(0, localStart);
    const suffix = text.slice(localEnd);

    if (i === startNodeIndex && i === endNodeIndex) {
      replaceAcrossRuns(
        paragraph,
        textNodes[i]!,
        textNodes[i]!,
        prefix,
        replacement,
        suffix,
      );
      return;
    }

    if (i === startNodeIndex) {
      let endCum = 0;
      for (let j = 0; j < endNodeIndex; j += 1) {
        endCum += getTextContent(textNodes[j]!).length;
      }
      const endText = getTextContent(textNodes[endNodeIndex]!);
      let endLocalEnd = Math.min(endIndex - endCum, endText.length);
      if (endLocalEnd < 0) {
        endLocalEnd = 0;
      }
      replaceAcrossRuns(
        paragraph,
        textNodes[startNodeIndex]!,
        textNodes[endNodeIndex]!,
        prefix,
        replacement,
        endText.slice(endLocalEnd),
      );
      return;
    }
  }
}

function replaceRegexTokenInParagraph(
  paragraph: Element,
  tokenRegex: RegExp,
  replacement: string,
): void {
  while (true) {
    const textNodes = descendants(paragraph, 't');
    if (textNodes.length === 0) {
      return;
    }

    const mergedText = textNodes.map(getTextContent).join('');
    const flags = tokenRegex.flags.includes('g')
      ? tokenRegex.flags
      : `${tokenRegex.flags}g`;
    const re = new RegExp(tokenRegex.source, flags);
    const matches = [...mergedText.matchAll(re)];
    if (matches.length === 0) {
      return;
    }

    const match = matches[matches.length - 1]!;
    replaceRangeAcrossNodes(
      paragraph,
      textNodes,
      match.index,
      match[0].length,
      replacement,
    );
  }
}

function replacePlaceholdersInParagraph(
  paragraph: Element,
  placeholders: Record<string, string>,
): void {
  while (true) {
    const textNodes = descendants(paragraph, 't');
    if (textNodes.length === 0) {
      return;
    }

    const mergedText = textNodes.map(getTextContent).join('');
    PLACEHOLDER_REGEX.lastIndex = 0;
    const matches = [...mergedText.matchAll(PLACEHOLDER_REGEX)];
    if (matches.length === 0) {
      return;
    }

    const match = matches[matches.length - 1]!;
    const key = (match[1] ?? '').trim();
    const replacement = getPlaceholder(placeholders, key) ?? '';
    replaceRangeAcrossNodes(
      paragraph,
      textNodes,
      match.index,
      match[0].length,
      replacement,
    );
  }
}

function getSkillEntries(
  placeholders: Record<string, string>,
): Array<{ group: string; value: string }> {
  const entries: Array<{ group: string; value: string }> = [];
  for (let index = 1; ; index += 1) {
    let group = getPlaceholder(placeholders, `Skill-Group-${index}`) ?? '';
    if (!group.trim()) {
      group = getPlaceholder(placeholders, `Skill-Groups-${index}`) ?? '';
    }
    const skills = getPlaceholder(placeholders, `Skills-${index}`) ?? '';
    if (!group.trim() && !skills.trim()) {
      break;
    }
    entries.push({ group, value: skills });
  }
  return entries;
}

function fillSkillLineParagraph(
  paragraph: Element,
  group: string,
  skills: string,
): void {
  replaceRegexTokenInParagraph(paragraph, ANY_SKILL_GROUP_TOKEN, group);
  replaceRegexTokenInParagraph(paragraph, ANY_SKILLS_VALUE_TOKEN, skills);
}

function applySkillLines(
  root: Element,
  placeholders: Record<string, string>,
): void {
  const skillEntries = getSkillEntries(placeholders);
  const skillParagraphs: Element[] = [];
  for (const paragraph of descendants(root, 'p')) {
    const paragraphText = getParagraphText(paragraph);
    ANY_SKILL_GROUP_TOKEN.lastIndex = 0;
    if (ANY_SKILL_GROUP_TOKEN.test(paragraphText)) {
      skillParagraphs.push(paragraph);
    }
  }

  if (skillParagraphs.length === 0) {
    return;
  }

  if (skillEntries.length === 0) {
    for (const paragraph of skillParagraphs) {
      removeNode(paragraph);
    }
    return;
  }

  while (skillParagraphs.length < skillEntries.length) {
    const anchor = skillParagraphs[skillParagraphs.length - 1]!;
    const clone = anchor.cloneNode(true) as Element;
    insertAfter(anchor, clone);
    skillParagraphs.push(clone);
  }

  while (skillParagraphs.length > skillEntries.length) {
    const extra = skillParagraphs[skillParagraphs.length - 1]!;
    removeNode(extra);
    skillParagraphs.pop();
  }

  for (let index = 0; index < skillEntries.length; index += 1) {
    const entry = skillEntries[index]!;
    fillSkillLineParagraph(skillParagraphs[index]!, entry.group, entry.value);
  }
}

function isWhitespaceIgnoredEqual(text: string, token: string): boolean {
  let tokenIndex = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      continue;
    }
    if (
      tokenIndex >= token.length ||
      ch.toUpperCase() !== token[tokenIndex]!.toUpperCase()
    ) {
      return false;
    }
    tokenIndex += 1;
  }
  return tokenIndex === token.length;
}

function createParagraphFromTemplate(
  templateParagraph: Element,
  line: string,
): Element {
  const doc = templateParagraph.ownerDocument!;
  const paragraph = createW(doc, 'p');

  const pPr = directChildren(templateParagraph, 'pPr')[0];
  if (pPr) {
    paragraph.appendChild(pPr.cloneNode(true));
  }

  const runs = directChildren(templateParagraph, 'r');
  const firstRun = runs[0];
  const lastRun = runs[runs.length - 1];
  const normalRunProperties = cloneRunProperties(
    firstRun ? directChildren(firstRun, 'rPr')[0] : undefined,
  );
  const boldRunProperties = cloneRunProperties(
    lastRun ? directChildren(lastRun, 'rPr')[0] : undefined,
  );

  let valueRunProperties: Element | null = null;
  if (normalRunProperties) {
    valueRunProperties = normalRunProperties.cloneNode(true) as Element;
  } else if (boldRunProperties) {
    valueRunProperties = boldRunProperties.cloneNode(true) as Element;
  }
  if (valueRunProperties) {
    removeBoldChildren(valueRunProperties);
  }

  const separatorIndex = line.indexOf(':');
  if (separatorIndex > 0) {
    const label = line.slice(0, separatorIndex + 1);
    const value = line.slice(separatorIndex + 1).replace(/^\s+/, '');

    paragraph.appendChild(createRun(doc, boldRunProperties, label));
    if (value.trim()) {
      for (const run of createRunsFromFormattedText(
        doc,
        valueRunProperties,
        ` ${value}`,
      )) {
        paragraph.appendChild(run);
      }
    }
  } else {
    for (const run of createRunsFromFormattedText(
      doc,
      valueRunProperties,
      line,
    )) {
      paragraph.appendChild(run);
    }
  }

  return paragraph;
}

function tryExpandPlaceholderParagraph(
  paragraph: Element,
  placeholderName: string,
  replacement: string,
  cachedParagraphText?: string,
): boolean {
  const token = `<${placeholderName}>`;
  const mergedText = cachedParagraphText ?? getParagraphText(paragraph);
  if (!mergedText.toLowerCase().includes(token.toLowerCase())) {
    return false;
  }
  if (!isWhitespaceIgnoredEqual(mergedText, token)) {
    return false;
  }

  const lines = normalizeNewlines(replacement)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    removeNode(paragraph);
    return true;
  }

  let insertAfterNode: Node = paragraph;
  for (const line of lines) {
    const newParagraph = createParagraphFromTemplate(paragraph, line);
    insertAfter(insertAfterNode, newParagraph);
    insertAfterNode = newParagraph;
  }

  removeNode(paragraph);
  return true;
}

function expandMultiLinePlaceholderParagraphs(
  root: Element,
  placeholders: Record<string, string>,
): void {
  const multilinePlaceholders = Object.entries(placeholders).filter(([, v]) =>
    v.includes('\n'),
  );
  if (multilinePlaceholders.length === 0) {
    return;
  }

  const multilineNames = new Set(
    multilinePlaceholders.map(([key]) => key.toLowerCase()),
  );

  for (const paragraph of [...descendants(root, 'p')]) {
    const paragraphText = getParagraphText(paragraph);
    if (!paragraphText.includes('<')) {
      continue;
    }

    let hasCandidate = false;
    const lowerText = paragraphText.toLowerCase();
    for (const name of multilineNames) {
      if (lowerText.includes(name)) {
        hasCandidate = true;
        break;
      }
    }
    if (!hasCandidate) {
      continue;
    }

    for (const [placeholderName, replacement] of multilinePlaceholders) {
      if (
        tryExpandPlaceholderParagraph(
          paragraph,
          placeholderName,
          replacement,
          paragraphText,
        )
      ) {
        break;
      }
    }
  }
}

function hasNumberingProperties(paragraph: Element): boolean {
  const pPr = directChildren(paragraph, 'pPr')[0];
  if (!pPr) {
    return false;
  }
  return directChildren(pPr, 'numPr').length > 0;
}

function removeEmptyFilledParagraphs(root: Element): void {
  for (const paragraph of [...descendants(root, 'p')]) {
    const text = getParagraphText(paragraph).trim();
    const isListItem = hasNumberingProperties(paragraph);

    if (isListItem && !text) {
      removeNode(paragraph);
      continue;
    }

    if (text === ':') {
      removeNode(paragraph);
    }
  }
}

function processRoot(
  root: Element,
  placeholders: Record<string, string>,
): void {
  applySkillLines(root, placeholders);
  expandMultiLinePlaceholderParagraphs(root, placeholders);

  for (const paragraph of descendants(root, 'p')) {
    replacePlaceholdersInParagraph(paragraph, placeholders);
  }

  removeEmptyFilledParagraphs(root);
}

function isMergePartPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  if (normalized === 'word/document.xml') {
    return true;
  }
  return (
    /^word\/header[^/]*\.xml$/i.test(normalized) ||
    /^word\/footer[^/]*\.xml$/i.test(normalized)
  );
}

/**
 * Merge placeholder values into a .docx template (document + headers/footers).
 */
export async function mergeTemplate(
  templateBytes: Buffer,
  placeholders: Record<string, string>,
  properties: DocumentProperties = {},
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(templateBytes);
  const parser = new DOMParser();
  const serializer = new XMLSerializer();

  const paths = Object.keys(zip.files).filter(
    (name) => !zip.files[name]?.dir && isMergePartPath(name),
  );

  for (const path of paths) {
    const file = zip.file(path);
    if (!file) {
      continue;
    }
    const xml = await file.async('string');
    const dom = parser.parseFromString(xml, 'application/xml');
    const root = dom.documentElement;
    if (!root) {
      continue;
    }
    processRoot(root, placeholders);
    zip.file(path, serializer.serializeToString(dom));
  }

  await scrubDocumentProperties(zip, properties);

  const result = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
  return Buffer.from(result);
}
