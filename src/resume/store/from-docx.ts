import JSZip from 'jszip';
import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import { mergeJsonWithTemplate } from '../maker/merge.js';

/**
 * An old Resume's Word file back to the JSON it was made from — so it can be
 * kept as JSON like every new Resume (`scripts/resumes-to-json.ts`).
 *
 * The Word file was made by filling a template's `<Tag>`s (`merge-docx.ts`),
 * so the template is lined up with the file paragraph by paragraph, and each
 * tag's value read off from where it landed. The merge's own rules are
 * followed backwards: a skill line repeated once per skill group, a tag alone
 * in its paragraph spread over several paragraphs (one per line), a list item
 * or a lone ":" removed when it came out empty, and bold text written as
 * `**highlight**`.
 *
 * Nothing is taken on trust: the Resume is built again from the JSON found,
 * and accepted only when every paragraph's text — bold included — is the same
 * as in the old file. Anything else is refused (the old file is then kept as
 * it is).
 */

const PLACEHOLDER = /<\s*([^<>]+?)\s*>/g;
const SKILL_GROUP_TAG = /^Skill-Groups?(?:-\d+)?$/i;
const SKILLS_TAG = /^Skills(?:-\d+)?$/i;
const MAX_LINES = 60;

interface Para {
  /** The text with bold parts as `**…**`, line breaks as `\n`, tabs as `\t`. */
  marked: string;
  plain: string;
  listItem: boolean;
}

interface TemplatePara extends Para {
  tags: string[];
  /** The paragraph is this tag alone: a multi-line value is spread over paragraphs. */
  wholeTag: string | null;
  skill: boolean;
  regex: RegExp;
  /** Empty after the merge, so removed: a list item with nothing in it, or a lone ":". */
  removable: boolean;
}

const localName = (node: Node): string => {
  const el = node as Element;
  if (el.localName) return el.localName;
  const raw = el.nodeName ?? '';
  const colon = raw.indexOf(':');
  return colon >= 0 ? raw.slice(colon + 1) : raw;
};

function descendants(root: Node, name: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Node) => {
    if (node.nodeType !== 1) return;
    if (localName(node) === name) out.push(node as Element);
    for (let i = 0; i < node.childNodes.length; i += 1) walk(node.childNodes.item(i)!);
  };
  walk(root);
  return out;
}

function child(parent: Element, name: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)!;
    if (node.nodeType === 1 && localName(node) === name) return node as Element;
  }
  return null;
}

function isBold(run: Element): boolean {
  const rPr = child(run, 'rPr');
  const b = rPr ? child(rPr, 'b') : null;
  if (!b) return false;
  const value = (b.getAttribute('w:val') ?? b.getAttribute('val') ?? '').toLowerCase();
  return value !== '0' && value !== 'false';
}

/** One paragraph as text, bold marked, in document order (text boxes inside it included, as the merge reads it). */
function readParagraph(paragraph: Element): Para {
  const segments: { text: string; bold: boolean }[] = [];
  for (const run of descendants(paragraph, 'r')) {
    const bold = isBold(run);
    for (let i = 0; i < run.childNodes.length; i += 1) {
      const node = run.childNodes.item(i)!;
      if (node.nodeType !== 1) continue;
      const name = localName(node);
      if (name === 't') segments.push({ text: node.textContent ?? '', bold });
      else if (name === 'tab') segments.push({ text: '\t', bold });
      else if (name === 'br' || name === 'cr') segments.push({ text: '\n', bold });
    }
  }
  let marked = '';
  let plain = '';
  let current = '';
  let currentBold = false;
  const flush = () => {
    if (current) marked += currentBold ? `**${current}**` : current;
    current = '';
  };
  for (const segment of segments) {
    plain += segment.text;
    // Bold spaces read as plain: they look the same.
    const bold = segment.bold && segment.text.trim() !== '';
    if (bold !== currentBold) {
      flush();
      currentBold = bold;
    }
    current += segment.text;
  }
  flush();
  const pPr = child(paragraph, 'pPr');
  return { marked, plain, listItem: Boolean(pPr && child(pPr, 'numPr')) };
}

const isMergePart = (name: string) => /^word\/(document|header[^/]*|footer[^/]*)\.xml$/i.test(name.replace(/\\/g, '/'));

/** Every paragraph of the parts a merge fills (body, headers, footers), by part. */
export async function readDocx(bytes: Buffer): Promise<Map<string, Para[]>> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = new Map<string, Para[]>();
  for (const name of Object.keys(zip.files).filter(isMergePart).sort()) {
    const xml = await zip.file(name)!.async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (!doc.documentElement) continue;
    parts.set(name, descendants(doc.documentElement, 'p').map(readParagraph));
  }
  return parts;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function templatePara(para: Para): TemplatePara {
  // Bold marks, tags and plain text, in order.
  type Token = { kind: 'bold' } | { kind: 'tag'; name: string } | { kind: 'text'; text: string };
  const tokens: Token[] = [];
  const TOKEN = /\*\*|<\s*([^<>]+?)\s*>/g;
  let last = 0;
  for (const match of para.marked.matchAll(TOKEN)) {
    if (match.index! > last) tokens.push({ kind: 'text', text: para.marked.slice(last, match.index) });
    tokens.push(match[0] === '**' ? { kind: 'bold' } : { kind: 'tag', name: (match[1] ?? '').trim() });
    last = match.index! + match[0].length;
  }
  if (last < para.marked.length) tokens.push({ kind: 'text', text: para.marked.slice(last) });

  const tags: string[] = [];
  let pattern = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    const after = tokens[i + 2];
    if (token.kind === 'bold' && next?.kind === 'tag' && after?.kind === 'bold') {
      // A bold tag alone: an empty value leaves no bold text, so no marks either.
      tags.push(next.name);
      pattern += String.raw`(?:\*\*([\s\S]+?)\*\*)?`;
      i += 2;
    } else if (token.kind === 'tag') {
      tags.push(token.name);
      pattern += String.raw`([\s\S]*?)`;
    } else {
      pattern += escape(token.kind === 'bold' ? '**' : token.text);
    }
  }
  const compact = para.plain.replace(/\s+/g, '');
  const wholeTag = tags.length === 1 && compact.toLowerCase() === `<${tags[0]}>`.replace(/\s+/g, '').toLowerCase() ? tags[0]! : null;
  const leftover = para.plain.replace(PLACEHOLDER, '').trim();
  return {
    ...para,
    tags,
    wholeTag,
    skill: tags.some((tag) => SKILL_GROUP_TAG.test(tag)),
    regex: new RegExp(`^${pattern}$`),
    removable: (para.listItem && leftover === '') || leftover === ':',
  };
}

type Step =
  | { kind: 'one'; t: number; r: number }
  | { kind: 'none'; t: number }
  | { kind: 'lines'; t: number; r: number; count: number }
  | { kind: 'skills'; t: number; templates: number; r: number; count: number };

/** Every way (best first) the template's paragraphs can line up with the file's, to the end. */
function* alignments(tpl: TemplatePara[], real: Para[]): Generator<Step[]> {
  const dead = new Set<string>();
  function* from(i: number, j: number): Generator<Step[]> {
    if (i === tpl.length) {
      if (j === real.length) yield [];
      return;
    }
    const key = `${i}:${j}`;
    if (dead.has(key)) return;
    let found = false;
    const t = tpl[i]!;
    const tryNext = function* (step: Step, nextI: number, nextJ: number): Generator<Step[]> {
      for (const rest of from(nextI, nextJ)) {
        found = true;
        yield [step, ...rest];
      }
    };

    if (t.skill) {
      // The skill lines: one per skill group, each a copy of the template's skill line (the last one repeated).
      let templates = 0;
      while (i + templates < tpl.length && tpl[i + templates]!.skill) templates += 1;
      let max = 0;
      while (j + max < real.length && tpl[i + Math.min(max, templates - 1)]!.regex.test(real[j + max]!.marked)) max += 1;
      for (let count = max; count >= 0; count -= 1) {
        yield* tryNext({ kind: 'skills', t: i, templates, r: j, count }, i + templates, j + count);
      }
    } else {
      if (j < real.length && t.regex.test(real[j]!.marked)) yield* tryNext({ kind: 'one', t: i, r: j }, i + 1, j + 1);
      if (t.wholeTag) {
        let max = 0;
        while (max < MAX_LINES && j + max < real.length && real[j + max]!.plain.trim() !== '') max += 1;
        for (let count = max; count >= 2; count -= 1) yield* tryNext({ kind: 'lines', t: i, r: j, count }, i + 1, j + count);
      }
      if (t.removable) yield* tryNext({ kind: 'none', t: i }, i + 1, j);
    }
    if (!found) dead.add(key);
  }
  yield* from(0, 0);
}

/** A line written by `createParagraphFromTemplate`: its "Label:" is bold by the template, not by the value. */
function lineValue(marked: string): string {
  const label = /^\*\*([^*\n]+?:)\*\*\s?([\s\S]*)$/.exec(marked);
  return label ? `${label[1]} ${label[2]}`.trimEnd() : marked;
}

/** The values a full alignment reads off, or null when one tag would need two different values. */
function valuesOf(steps: Step[], tpl: TemplatePara[], real: Para[]): Map<string, { tag: string; value: string }> | null {
  const values = new Map<string, { tag: string; value: string }>();
  const set = (tag: string, value: string): boolean => {
    const key = tag.toLowerCase();
    const known = values.get(key);
    if (known && known.value !== value) return false;
    values.set(key, { tag, value });
    return true;
  };
  for (const step of steps) {
    if (step.kind === 'one') {
      const t = tpl[step.t]!;
      const match = t.regex.exec(real[step.r]!.marked);
      if (!match) return null;
      for (let k = 0; k < t.tags.length; k += 1) if (!set(t.tags[k]!, match[k + 1] ?? '')) return null;
    } else if (step.kind === 'none') {
      for (const tag of tpl[step.t]!.tags) if (!set(tag, '')) return null;
    } else if (step.kind === 'lines') {
      const lines = real.slice(step.r, step.r + step.count).map((para) => lineValue(para.marked));
      if (!set(tpl[step.t]!.wholeTag!, lines.join('\n'))) return null;
    } else {
      for (let q = 0; q < step.count; q += 1) {
        const t = tpl[step.t + Math.min(q, step.templates - 1)]!;
        const match = t.regex.exec(real[step.r + q]!.marked);
        if (!match) return null;
        for (let k = 0; k < t.tags.length; k += 1) {
          const tag = t.tags[k]!;
          const value = match[k + 1] ?? '';
          if (SKILL_GROUP_TAG.test(tag)) {
            if (!set(`Skill-Group-${q + 1}`, value)) return null;
          } else if (SKILLS_TAG.test(tag)) {
            if (!set(`Skills-${q + 1}`, value)) return null;
          } else if (!set(tag, value)) {
            return null;
          }
        }
      }
    }
  }
  return values;
}

const sameParts = (a: Map<string, Para[]>, b: Map<string, Para[]>) => {
  if (a.size !== b.size) return false;
  for (const [part, paras] of a) {
    const other = b.get(part);
    if (!other || other.length !== paras.length) return false;
    for (let i = 0; i < paras.length; i += 1) if (paras[i]!.marked !== other[i]!.marked) return false;
  }
  return true;
};

export type FromDocxResult = { ok: true; json: Record<string, string> } | { ok: false; reason: string };

/** Templates read once: "Make files" and the conversion try the same few over and over. */
const templateCache = new Map<string, Map<string, TemplatePara[]>>();

async function templateParts(template: Buffer): Promise<Map<string, TemplatePara[]>> {
  const key = `${template.byteLength}:${template.subarray(0, 64).toString('base64')}:${template.subarray(-64).toString('base64')}`;
  const cached = templateCache.get(key);
  if (cached) return cached;
  const parts = new Map<string, TemplatePara[]>();
  for (const [part, paras] of await readDocx(template)) parts.set(part, paras.map(templatePara));
  if (templateCache.size > 32) templateCache.clear();
  templateCache.set(key, parts);
  return parts;
}

/** How many alignments are tried (built again and compared) before giving up on a template. */
const MAX_TRIES = 6;

/**
 * The JSON an old Resume's Word file was made from with `template`, checked
 * by building it again — or why not.
 */
export async function jsonFromDocx(docx: Buffer, template: Buffer): Promise<FromDocxResult> {
  let real: Map<string, Para[]>;
  try {
    real = await readDocx(docx);
  } catch {
    return { ok: false, reason: 'the Word file could not be read' };
  }
  const tpl = await templateParts(template);
  for (const part of tpl.keys()) if (!real.has(part)) return { ok: false, reason: `the Word file has no ${part}` };

  // Each part lined up on its own; the first few full alignments of each are tried together.
  const options: Map<string, Step[][]> = new Map();
  for (const [part, paras] of tpl) {
    const found: Step[][] = [];
    for (const steps of alignments(paras, real.get(part)!)) {
      found.push(steps);
      if (found.length >= MAX_TRIES) break;
    }
    if (found.length === 0) return { ok: false, reason: `${part} does not line up with this template` };
    options.set(part, found);
  }

  const parts = [...tpl.keys()];
  let tries = 0;
  // Combinations, first choices first: in practice every part but the body has one way to line up.
  const pick = async (index: number, chosen: Map<string, { tag: string; value: string }>): Promise<Record<string, string> | null> => {
    if (index === parts.length) {
      if (tries >= MAX_TRIES) return null;
      tries += 1;
      const json: Record<string, string> = {};
      for (const { tag, value } of chosen.values()) json[tag] = value;
      try {
        const rebuilt = await readDocx((await mergeJsonWithTemplate(template, json)).docx);
        // Only the parts a merge fills, as the old file has them.
        const compare = new Map([...real].filter(([part]) => tpl.has(part)));
        const built = new Map([...rebuilt].filter(([part]) => tpl.has(part)));
        return sameParts(compare, built) ? json : null;
      } catch {
        return null;
      }
    }
    const part = parts[index]!;
    for (const steps of options.get(part)!) {
      const values = valuesOf(steps, tpl.get(part)!, real.get(part)!);
      if (!values) continue;
      const merged = new Map(chosen);
      let clash = false;
      for (const [key, entry] of values) {
        const known = merged.get(key);
        if (known && known.value !== entry.value) {
          clash = true;
          break;
        }
        merged.set(key, entry);
      }
      if (clash) continue;
      const result = await pick(index + 1, merged);
      if (result) return result;
      if (tries >= MAX_TRIES) return null;
    }
    return null;
  };

  const json = await pick(0, new Map());
  return json ? { ok: true, json } : { ok: false, reason: 'built again from the values found, it is not the same Resume' };
}
