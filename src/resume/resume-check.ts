import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { Prisma as PrismaTypes } from '../generated/prisma/client.js';
import { companyKey } from '../domain/company.js';
import { logger } from '../logger.js';
import { prisma } from '../prisma.js';

/**
 * The Resume check: reads an application's stored Resume (the Word file's
 * text, headers included) and its cover letter, and flags the ones that need
 * a remake — with the reasons in words, shown in the desktop app.
 *
 * Rules only, no AI: they catch what has actually gone wrong before —
 *  - placeholders and notes to the candidate ("[Confirm official job title]",
 *    "by X%", "(verify proficiency)", "Draft for candidate verification"),
 *    and the request's own `target_company` / `job_description` echoed back;
 *  - an almost empty Resume, or an empty Summary / Skills / Experience section;
 *  - another person's Resume: the Profile's name missing, someone else's email,
 *    the Profile's recent employers missing;
 *  - the same Resume text on another application;
 *  - the PDF or the Word file missing;
 *  - a cover letter written for another company, never naming this one, with
 *    placeholders, or almost empty.
 *
 * Stored on the application (`resumeCheckStatus`, `resumeCheckReasons`,
 * `resumeCheckedAt`, `resumeTextHash`). A Resume the maker makes is checked as
 * it is saved; the rest by "Check all" on the Resume Maker page.
 */

export interface ResumeCheck {
  status: 'ok' | 'flagged';
  reasons: string[];
  checkedAt: string;
}

const DRAFT_MARKS: RegExp[] = [
  // [Confirm official job title], [verified percentage]
  /\[[^[\]\n]{1,120}\]/g,
  // by X%
  /\b[XYN]{1,2} ?%/g,
  // (verify proficiency), (confirm hands-on experience)
  /\((?:verify|confirm|to be (?:confirmed|verified))[^()\n]{0,80}\)/gi,
  // "Draft for candidate verification", "in this draft…"
  /\b(?:candidate verification|in this draft|draft for|placeholders?|before submission|lorem ipsum)\b/gi,
  // The request's own input echoed back as the answer.
  /\b(?:target_company|target_role|job_description)\b/g,
  /\{[^{}\n]{0,60}\}/g,
];

const HEADING = /^(?:professional\s+|career\s+|executive\s+)?(?:summary|profile)$|^(?:technical\s+|core\s+|key\s+)?(?:skills|competencies)(?:\s*(?:&|and)\s*\w+)?$|^(?:professional\s+|work\s+|relevant\s+)?experience$|^education(?:\s*(?:&|and)\s*\w+)?$|^certifications?$|^projects$/i;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

function squash(text: string): string {
  return text.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function words(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The paragraphs of a .docx — its body, headers and footers — one per line. */
export async function docxText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.keys(zip.files)
    .filter((name) => /^word\/(header[^/]*|document|footer[^/]*)\.xml$/i.test(name.replace(/\\/g, '/')))
    .sort((a, b) => (/header/i.test(a) ? -1 : /header/i.test(b) ? 1 : 0));
  const lines: string[] = [];
  for (const part of parts) {
    const xml = await zip.file(part)!.async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const paragraphs = doc.getElementsByTagName('w:p');
    for (let p = 0; p < paragraphs.length; p += 1) {
      const texts = paragraphs[p]!.getElementsByTagName('w:t');
      let text = '';
      for (let t = 0; t < texts.length; t += 1) text += texts[t]!.textContent ?? '';
      if (text.trim()) lines.push(text.trim());
    }
  }
  return lines.join('\n');
}

/** Up to three of the draft marks in `text`, quoted. */
function draftMarks(text: string): string[] {
  const found = new Set<string>();
  for (const mark of DRAFT_MARKS) {
    for (const match of text.matchAll(mark)) found.add(match[0].trim().slice(0, 60));
  }
  return [...found].slice(0, 3);
}

function quoteList(items: string[]): string {
  return items.map((item) => `“${item}”`).join(', ');
}

/** Whether `text` names `company` (its key, or its first word when that is distinctive). */
function mentions(text: string, company: string): boolean {
  const flat = squash(text);
  const key = companyKey(company);
  if (key.length >= 3 && flat.includes(key)) return true;
  const first = squash(company.split(/\s+/)[0] ?? '');
  return first.length >= 4 && flat.includes(first);
}

/** Empty sections: a heading followed by (almost) nothing before the next heading. */
function emptySections(lines: string[]): string[] {
  const empty: string[] = [];
  const headings = lines
    .map((line, index) => ({ line: line.replace(/[:\s]+$/, ''), index }))
    .filter(({ line }) => line.length <= 40 && HEADING.test(line));
  headings.forEach((heading, i) => {
    const end = headings[i + 1]?.index ?? lines.length;
    const body = lines.slice(heading.index + 1, end).join(' ');
    if (words(body) < 4) empty.push(heading.line.toUpperCase());
  });
  return empty;
}

interface Person {
  firstName: string;
  lastName: string;
  email: string;
  companies: string[];
}

/** The rules for one Resume's text and its cover letter; an empty list when it is fine. */
export function resumeProblems(
  text: string,
  context: {
    company: string;
    person: Person | null;
    files: string[];
    letter: unknown;
    duplicateOf?: { number: number; company: string } | null;
  },
): string[] {
  const reasons: string[] = [];
  const lines = text.split('\n');

  if (context.files.length) {
    if (!context.files.includes('pdf')) reasons.push('the PDF is missing');
    if (!context.files.includes('docx')) reasons.push('the Word file is missing');
  }

  const count = words(text);
  if (count < 150) reasons.push(`the Resume is almost empty (${count} words)`);
  else for (const section of emptySections(lines)) reasons.push(`the ${section} section is empty`);

  const marks = draftMarks(text);
  if (marks.length) reasons.push(`placeholders or notes in the Resume: ${quoteList(marks)}`);

  const person = context.person;
  if (person) {
    const flat = squash(text);
    const name = [person.firstName, person.lastName].filter(Boolean).join(' ');
    const onIt = (part: string) => squash(part).length < 2 || flat.includes(squash(part));
    if (name && !(onIt(person.firstName) && onIt(person.lastName))) {
      reasons.push(`the Profile's name (${name}) is not on it`);
    }
    const own = person.email.trim().toLowerCase();
    if (own) {
      const others = [...new Set((text.match(EMAIL) ?? []).map((e) => e.toLowerCase()))].filter((e) => e !== own);
      if (others.length) reasons.push(`another email is on it: ${others.slice(0, 2).join(', ')}`);
    }
    const missing = person.companies
      .filter((c) => companyKey(c).length >= 3)
      .slice(0, 3)
      .filter((c) => !mentions(text, c));
    if (missing.length) {
      reasons.push(
        `the Profile's employer${missing.length > 1 ? 's' : ''} ${quoteList(missing)} ${missing.length > 1 ? 'are' : 'is'} not on it (a job without its company?)`,
      );
    }
  }

  if (context.duplicateOf) {
    reasons.push(`the same Resume text as #${context.duplicateOf.number} (${context.duplicateOf.company})`);
  }

  reasons.push(...letterProblems(context.letter, context.company));
  return reasons;
}

function letterProblems(letter: unknown, company: string): string[] {
  if (!letter || typeof letter !== 'object') return [];
  const raw = letter as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const paragraphs = Array.isArray(raw.paragraphs) ? raw.paragraphs.map(str) : [];
  const body = [str(raw.greeting), ...paragraphs, str(raw.closing)].join('\n');
  const problems: string[] = [];
  if (words(paragraphs.join(' ')) < 60) problems.push('the cover letter is almost empty');
  const named = str(raw.company).trim();
  if (named && companyKey(named) !== companyKey(company) && !mentions(named, company) && !mentions(company, named)) {
    problems.push(`the cover letter was written for “${named}”, not ${company}`);
  } else if (paragraphs.length && !mentions(paragraphs.join(' '), company)) {
    problems.push(`the cover letter never names ${company}`);
  }
  const marks = draftMarks(body);
  if (marks.length) problems.push(`placeholders in the cover letter: ${quoteList(marks)}`);
  return problems;
}

const checkSelect = {
  id: true,
  number: true,
  company: true,
  profileId: true,
  resumeDocument: true,
  coverLetterDocument: true,
  resumeFiles: { select: { format: true } },
  profile: {
    select: {
      firstName: true,
      lastName: true,
      email: true,
      workExperience: { select: { company: true }, orderBy: { position: 'asc' as const } },
    },
  },
  user: {
    select: {
      profile: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          workExperience: { select: { company: true }, orderBy: { position: 'asc' as const } },
        },
      },
    },
  },
} as const;

/** The Resume's text: the stored Word file's, else the generated document's strings. */
async function resumeText(bidId: string, document: unknown): Promise<string | null> {
  const docx = await prisma.bidResumeFile.findUnique({
    where: { bidId_format: { bidId, format: 'docx' } },
    select: { data: true },
  });
  if (docx) return docxText(Buffer.from(docx.data));
  if (document === null || document === undefined) return null;
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(document);
  return strings.join('\n');
}

/**
 * Checks one application's Resume and letter and stores the result. Null when
 * it has no Resume (and the old result, if any, is cleared). The caller has
 * already checked that the user may see the application.
 */
export async function checkBid(bidId: string): Promise<ResumeCheck | null> {
  const bid = await prisma.bid.findUnique({ where: { id: bidId }, select: checkSelect });
  if (!bid) return null;
  let text: string | null = null;
  const files = bid.resumeFiles.map((f) => f.format);
  try {
    text = bid.resumeFiles.length || bid.resumeDocument !== null ? await resumeText(bid.id, bid.resumeDocument) : null;
  } catch (error) {
    logger.warn({ err: error, bidId }, 'Resume check: could not read the Word file');
    text = '';
  }
  if (text === null) {
    await clearCheck(bid.id);
    return null;
  }
  const hash = text.trim() ? createHash('sha256').update(squash(text)).digest('hex') : null;
  const twin = hash
    ? await prisma.bid.findFirst({
        where: { resumeTextHash: hash, id: { not: bid.id } },
        select: { number: true, company: true },
        orderBy: { createdAt: 'asc' },
      })
    : null;
  const source = bid.profile ?? bid.user?.profile ?? null;
  const person: Person | null = source
    ? {
        firstName: source.firstName ?? '',
        lastName: source.lastName ?? '',
        email: source.email ?? '',
        companies: source.workExperience.map((w) => w.company),
      }
    : null;
  const reasons = text.trim()
    ? resumeProblems(text, { company: bid.company, person, files, letter: bid.coverLetterDocument, duplicateOf: twin })
    : ['the Word file could not be read'];
  const checkedAt = new Date();
  const status = reasons.length ? 'flagged' : 'ok';
  await prisma.bid.update({
    where: { id: bid.id },
    data: { resumeCheckStatus: status, resumeCheckReasons: reasons, resumeCheckedAt: checkedAt, resumeTextHash: hash },
  });
  return { status, reasons, checkedAt: checkedAt.toISOString() };
}

/** `checkBid` that never throws — for the maker's save path. */
export async function checkBidQuietly(bidId: string): Promise<void> {
  try {
    await checkBid(bidId);
  } catch (error) {
    logger.warn({ err: error, bidId }, 'Resume check failed');
  }
}

export async function clearCheck(bidId: string): Promise<void> {
  await prisma.bid.updateMany({
    where: { id: bidId },
    data: { resumeCheckStatus: null, resumeCheckReasons: [], resumeCheckedAt: null, resumeTextHash: null },
  });
}

/** Has a Resume: a stored file or a generated document. */
export const HAS_RESUME: PrismaTypes.BidWhereInput = {
  OR: [{ resumeDocument: { not: PrismaTypes.AnyNull } }, { resumeFiles: { some: {} } }],
};

/** Checks every Draft (and Ready) application in `scope` that has a Resume. */
export async function checkAll(scope: PrismaTypes.BidWhereInput): Promise<{ checked: number; ok: number; flagged: number }> {
  const rows = await prisma.bid.findMany({
    where: { AND: [scope, { status: 'DRAFT' }, HAS_RESUME] },
    select: { id: true },
    orderBy: { number: 'asc' },
  });
  let ok = 0;
  let flagged = 0;
  // A few at a time: each reads one Word file (~100 KB) from the database.
  for (let i = 0; i < rows.length; i += 4) {
    const results = await Promise.all(rows.slice(i, i + 4).map((row) => checkBid(row.id).catch(() => null)));
    for (const result of results) {
      if (result?.status === 'ok') ok += 1;
      else if (result?.status === 'flagged') flagged += 1;
    }
  }
  return { checked: rows.length, ok, flagged };
}
