import { createHash } from 'node:crypto';
import { Prisma as PrismaTypes } from '../../generated/prisma/client.js';
import { NotFoundError } from '../../http/errors.js';
import { logger } from '../../logger.js';
import { prisma } from '../../prisma.js';
import { convertDocxToPdf, processMakerJson, renderStructuredWithMaker } from '../maker/maker.service.js';
import { AiResumeSchema } from '../resume.schemas.js';
import { renderCoverLetter } from '../../cover-letter/cover-letter.service.js';
import { CoverLetterPayloadSchema, type CoverLetterPayload } from '../../cover-letter/cover-letter.schemas.js';
import {
  dropKept,
  keptFormats,
  readCopy,
  readKept,
  writeCopy,
  type DocFormat,
} from './folder.js';
import { fileStem } from './names.js';
import { templateVersion } from './template-versions.js';

/**
 * Resumes and cover letters are kept as JSON in the database, and their Word
 * and PDF files as copies in the Resume folder (`folder.ts`). This is the one
 * place that turns the first into the second:
 *
 *   a file asked for → its copy in the folder → else built from the JSON (and
 *   saved as a copy) → else an old Resume's file (the `bid_resume_files` table,
 *   or the folder's `kept\`) → else nothing (the caller may render the
 *   website's own `resumeDocument`).
 */

export const CONTENT_TYPE: Record<DocFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Bump to have every copy built again (a change in how Resumes are laid out). */
const RENDER_VERSION = '1';

/** What a Resume was built with: enough to build the same one again. */
export interface ResumeBuild {
  /** `structured`: the app's own prompt's shape; `maker`: Maker JSON (a Resume Maker prompt). */
  kind: 'structured' | 'maker';
  templateId: string;
  templateSha256?: string;
  /** The Profile's name, for a structured Resume. */
  name?: string;
  /** The Profile's employers, for a structured Resume that names none. */
  fallbackCompanies?: string[];
  /** The start of the file names: `Jonathan_Bai_Acme`. */
  stem: string;
}

/** Has a Resume of any kind: JSON, an old stored file, a kept file, or the website's own document. */
export const HAS_RESUME: PrismaTypes.BidWhereInput = {
  OR: [
    { resumeAnswer: { not: PrismaTypes.AnyNull } },
    { resumeDocument: { not: PrismaTypes.AnyNull } },
    { resumeFiles: { some: {} } },
    { resumeKept: true },
  ],
};

/** No Resume at all. */
export const NO_RESUME: PrismaTypes.BidWhereInput = {
  resumeAnswer: { equals: PrismaTypes.AnyNull },
  resumeDocument: { equals: PrismaTypes.AnyNull },
  resumeFiles: { none: {} },
  resumeKept: false,
};

/** A Resume the maker can write a cover letter from (not the website's own document). */
export const HAS_MADE_RESUME: PrismaTypes.BidWhereInput = {
  OR: [{ resumeAnswer: { not: PrismaTypes.AnyNull } }, { resumeFiles: { some: {} } }, { resumeKept: true }],
};

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 12);

/** The copy's key: changes whenever the JSON or what it is built with does. */
export const resumeKey = (answer: unknown, build: ResumeBuild) =>
  hash(JSON.stringify(answer), JSON.stringify(build), RENDER_VERSION);

export const letterKey = (letter: unknown, date: string, profileId: string | null | undefined) =>
  hash(JSON.stringify(letter), date, profileId ?? '', RENDER_VERSION);

/** `Bid.resumeBuild` as stored, or null when it is not one. */
export function parseBuild(value: unknown): ResumeBuild | null {
  if (!value || typeof value !== 'object') return null;
  const build = value as Partial<ResumeBuild>;
  if ((build.kind !== 'structured' && build.kind !== 'maker') || typeof build.templateId !== 'string') return null;
  return { ...build, stem: typeof build.stem === 'string' && build.stem ? build.stem : 'Resume' } as ResumeBuild;
}

export const resumeFileName = (stem: string, format: DocFormat) => `${stem || 'Resume'}_resume.${format}`;

/** The Resume's Word file, built from its JSON with the template version it was made with. */
export async function buildResumeDocx(answer: unknown, build: ResumeBuild): Promise<Buffer> {
  const template = await templateVersion(build.templateSha256, build.templateId);
  if (build.kind === 'structured') {
    const parsed = AiResumeSchema.safeParse(answer);
    if (parsed.success) {
      const rendered = await renderStructuredWithMaker({
        document: parsed.data,
        format: 'docx',
        name: build.name || undefined,
        fallbackCompanies: build.fallbackCompanies,
        templateId: template.id,
        template,
      });
      return rendered.file;
    }
  }
  return (await processMakerJson({ json: answer as object, format: 'docx', templateId: template.id, template })).file;
}

/** One build at a time per file: two requests for the same missing copy share the work. */
const building = new Map<string, Promise<Buffer>>();

function once(key: string, work: () => Promise<Buffer>): Promise<Buffer> {
  const running = building.get(key);
  if (running) return running;
  const promise = work().finally(() => building.delete(key));
  building.set(key, promise);
  return promise;
}

/** Saves a copy, or logs: the file was made and is served anyway; a missing copy is built again next time. */
async function keepCopy(bidId: string, kind: 'resume' | 'cover-letter', key: string, format: DocFormat, name: string, data: Buffer) {
  try {
    await writeCopy(bidId, kind, key, format, { name, data });
  } catch (error) {
    logger.warn({ err: error, bidId, kind, format }, 'Resume folder: could not save a copy');
  }
}

/** The Resume's file from its JSON: the copy, else built (Word first; the PDF from the Word file) and kept. */
async function resumeFromAnswer(bidId: string, answer: unknown, build: ResumeBuild, format: DocFormat): Promise<Buffer> {
  const key = resumeKey(answer, build);
  const name = resumeFileName(build.stem, format);
  const copy = await readCopy(bidId, 'resume', key, format);
  if (copy) return copy.data;

  const docx = await once(`${bidId}:${key}:docx`, async () => {
    const stored = await readCopy(bidId, 'resume', key, 'docx');
    if (stored) return stored.data;
    const built = await buildResumeDocx(answer, build);
    await keepCopy(bidId, 'resume', key, 'docx', resumeFileName(build.stem, 'docx'), built);
    return built;
  });
  if (format === 'docx') return docx;
  return once(`${bidId}:${key}:pdf`, async () => {
    const pdf = await convertDocxToPdf(docx);
    await keepCopy(bidId, 'resume', key, 'pdf', name, pdf);
    return pdf;
  });
}

export interface ResumeFile {
  name: string;
  contentType: string;
  data: Buffer;
}

const resumeRow = {
  company: true,
  resumeAnswer: true,
  resumeBuild: true,
  resumeKept: true,
  backedUpAt: true,
  profile: { select: { firstName: true, lastName: true } },
  user: { select: { profile: { select: { firstName: true, lastName: true } } } },
} as const;

/** "In backup (2026-12-01)": its Resume was saved to a backup file and removed. */
export function inBackupError(backedUpAt: Date, what = 'Resume'): NotFoundError {
  return new NotFoundError(
    `This application's ${what} is in the backup of ${backedUpAt.toISOString().slice(0, 10)}. ` +
      'The Super Admin can put it back from that backup file (Storage → Restore).',
  );
}

/**
 * One application's Resume as PDF or Word — whatever kind it is — or null when
 * it has none of these (the website's own `resumeDocument` is the caller's).
 * The caller has already checked that the user may see the application.
 */
export async function resumeFile(bidId: string, format: DocFormat): Promise<ResumeFile | null> {
  const row = await prisma.bid.findUnique({ where: { id: bidId }, select: resumeRow });
  if (!row) return null;

  const build = parseBuild(row.resumeBuild);
  if (row.resumeAnswer !== null && build) {
    const data = await resumeFromAnswer(bidId, row.resumeAnswer, build, format);
    return { name: resumeFileName(build.stem, format), contentType: CONTENT_TYPE[format], data };
  }

  const old = await prisma.bidResumeFile.findUnique({
    where: { bidId_format: { bidId, format } },
    select: { name: true, contentType: true, data: true },
  });
  if (old) return { name: old.name, contentType: old.contentType, data: Buffer.from(old.data) };

  if (row.resumeKept) {
    const kept = await readKept(bidId, format);
    if (kept) return { name: kept.name, contentType: CONTENT_TYPE[format], data: kept.data };
  }

  if (row.backedUpAt) throw inBackupError(row.backedUpAt);
  return null;
}

/** The formats a Resume can be had in (for the Resume check's "the PDF is missing"). */
export async function resumeFormats(bidId: string): Promise<DocFormat[]> {
  const row = await prisma.bid.findUnique({
    where: { id: bidId },
    select: { resumeAnswer: true, resumeKept: true, resumeFiles: { select: { format: true } } },
  });
  if (!row) return [];
  if (row.resumeAnswer !== null) return ['pdf', 'docx'];
  const formats = new Set<DocFormat>(row.resumeFiles.map((file) => file.format as DocFormat));
  if (row.resumeKept) for (const format of await keptFormats(bidId)) formats.add(format);
  return [...formats];
}

/** The file stem for a Resume with no build info: the Profile's name and the company. */
export function stemFor(row: {
  company: string;
  profile?: { firstName: string | null; lastName: string | null } | null;
  user?: { profile?: { firstName: string | null; lastName: string | null } | null } | null;
}): string {
  const person = row.profile ?? row.user?.profile ?? null;
  return fileStem(person?.firstName ?? '', person?.lastName ?? '', row.company) || 'Resume';
}

/**
 * Saves a Resume the maker just made: its JSON and build on the application
 * (an old stored or kept file goes: this is its Resume now), and the files as
 * copies. Returns nothing; the caller still has the files to hand back.
 */
export async function saveMadeResume(input: {
  bidId: string;
  answer: unknown;
  build: ResumeBuild;
  docx: Buffer;
  pdf: Buffer;
}): Promise<void> {
  const { bidId, answer, build } = input;
  const existing = await prisma.bid.findUnique({ where: { id: bidId }, select: { resumeMadeAt: true, resumeKept: true } });
  await prisma.$transaction([
    prisma.bidResumeFile.deleteMany({ where: { bidId } }),
    prisma.bid.update({
      where: { id: bidId },
      data: {
        resumeAnswer: answer as PrismaTypes.InputJsonValue,
        resumeBuild: build as unknown as PrismaTypes.InputJsonValue,
        resumeKept: false,
        updatedAt: new Date(),
        ...(existing?.resumeMadeAt ? {} : { resumeMadeAt: new Date() }),
      },
    }),
  ]);
  if (existing?.resumeKept) await dropKept(bidId).catch((error) => logger.warn({ err: error, bidId }, 'Could not delete a kept Resume'));
  const key = resumeKey(answer, build);
  await keepCopy(bidId, 'resume', key, 'docx', resumeFileName(build.stem, 'docx'), input.docx);
  await keepCopy(bidId, 'resume', key, 'pdf', resumeFileName(build.stem, 'pdf'), input.pdf);
}

export interface LetterContext {
  bidId: string;
  /** The account the letter is rendered for (its Profile's name and contact line). */
  ownerUserId: string;
  /** The application's date, `YYYY-MM-DD`: the letter's date. */
  bidDate: string;
  profileId?: string | null;
}

/** The cover letter as PDF or Word: its copy in the folder, else rendered from its JSON and kept. */
export async function coverLetterFile(context: LetterContext, letter: CoverLetterPayload, format: DocFormat): Promise<ResumeFile> {
  const key = letterKey(letter, context.bidDate, context.profileId);
  const copy = await readCopy(context.bidId, 'cover-letter', key, format);
  if (copy) return { name: copy.name, contentType: CONTENT_TYPE[format], data: copy.data };

  let name = '';
  const data = await once(`${context.bidId}:letter:${key}:${format}`, async () => {
    const rendered = await renderCoverLetter(
      context.ownerUserId,
      { document: letter, format },
      { date: context.bidDate, profileId: context.profileId ?? undefined },
    );
    name = rendered.fileName;
    await keepCopy(context.bidId, 'cover-letter', key, format, rendered.fileName, rendered.file);
    return rendered.file;
  });
  if (!name) name = (await readCopy(context.bidId, 'cover-letter', key, format))?.name ?? `cover_letter.${format}`;
  return { name, contentType: CONTENT_TYPE[format], data };
}

/** The Resume's text as JSON strings, for a cover letter or a form: the maker's answer, else the website's document. */
export async function resumeJson(bidId: string): Promise<unknown | null> {
  const row = await prisma.bid.findUnique({ where: { id: bidId }, select: { resumeAnswer: true, resumeDocument: true } });
  return row?.resumeAnswer ?? row?.resumeDocument ?? null;
}

/** Builds every missing copy of one application (Resume and letter, both formats). */
export async function makeCopies(bidId: string): Promise<{ resume: boolean; letter: boolean }> {
  const row = await prisma.bid.findUnique({
    where: { id: bidId },
    select: {
      ...resumeRow,
      userId: true,
      profileId: true,
      bidDate: true,
      coverLetterDocument: true,
    },
  });
  if (!row) return { resume: false, letter: false };
  let resume = false;
  const build = parseBuild(row.resumeBuild);
  if (row.resumeAnswer !== null && build) {
    await resumeFromAnswer(bidId, row.resumeAnswer, build, 'docx');
    await resumeFromAnswer(bidId, row.resumeAnswer, build, 'pdf');
    resume = true;
  }
  let letter = false;
  const parsed = CoverLetterPayloadSchema.safeParse(row.coverLetterDocument);
  if (parsed.success) {
    // The owner only matters without a Profile: the letter is signed by the Profile when there is one.
    const context = { bidId, ownerUserId: row.userId, bidDate: row.bidDate.toISOString().slice(0, 10), profileId: row.profileId };
    await coverLetterFile(context, parsed.data, 'docx');
    await coverLetterFile(context, parsed.data, 'pdf');
    letter = true;
  }
  return { resume, letter };
}
