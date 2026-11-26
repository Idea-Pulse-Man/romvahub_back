import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BadRequestError } from '../../http/errors.js';
import { logger } from '../../logger.js';
import { prisma } from '../../prisma.js';

/**
 * The Resume folder: where the server keeps the Word and PDF files of each
 * application's Resume and cover letter.
 *
 * The database keeps only the JSON they are built from (`Bid.resumeAnswer`,
 * `Bid.coverLetterDocument`), so every file here is a copy: deleted by the
 * status rules (`cleanup.ts`), lost when the server moves, and built again
 * from the JSON the next time someone opens it. The one exception is `kept\`:
 * old Resumes that could not be turned into JSON, whose files are the only
 * copy (`yarn resumes:to-json`), and which nothing here ever deletes by itself.
 *
 *   <folder>\<application id>\resume-<key>\Jonathan_Bai_Acme_resume.docx / .pdf
 *   <folder>\<application id>\cover-letter-<key>\Jonathan_Bai_Acme_cover_letter.docx / .pdf
 *   <folder>\kept\<application id>\Jonathan_Bai_Acme_resume.docx / .pdf
 *
 * `<key>` is a short hash of the JSON and what it was built with: a Remake or
 * a new letter gets a new key, so an old file is never served for a new one.
 */

export type DocKind = 'resume' | 'cover-letter';
export type DocFormat = 'pdf' | 'docx';

export const KEPT_DIR = 'kept';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The backend folder (…\backend), from this module in `src\` or `dist\`. */
function backendRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** RESUME_FOLDER, else `files` next to the backend folder: C:\romva\files on the VPS. */
export function defaultResumeFolder(): string {
  const fromEnv = process.env.RESUME_FOLDER?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.resolve(backendRoot(), '..', 'files');
}

let cached: { folder: string; at: number } | null = null;
const CACHE_MS = 60_000;

/** The Resume folder now in use: the admin's choice, else the default. */
export async function resumeFolder(): Promise<string> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.folder;
  const row = await prisma.serverSettings.findUnique({ where: { id: 1 }, select: { resumeFolder: true } });
  const folder = row?.resumeFolder?.trim() ? path.resolve(row.resumeFolder.trim()) : defaultResumeFolder();
  cached = { folder, at: Date.now() };
  return folder;
}

export interface ResumeFolderInfo {
  folder: string;
  /** True when no admin has chosen one: RESUME_FOLDER or the default. */
  isDefault: boolean;
  defaultFolder: string;
}

export async function resumeFolderInfo(): Promise<ResumeFolderInfo> {
  const row = await prisma.serverSettings.findUnique({ where: { id: 1 }, select: { resumeFolder: true } });
  return {
    folder: await resumeFolder(),
    isDefault: !row?.resumeFolder?.trim(),
    defaultFolder: defaultResumeFolder(),
  };
}

/** Makes the folder and writes a file in it once, so a folder the server cannot use is refused at once. */
async function assertUsable(folder: string): Promise<void> {
  try {
    await fs.mkdir(folder, { recursive: true });
    const probe = path.join(folder, `.romva-write-test-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
    throw new BadRequestError(`The server cannot write to "${folder}" (${reason}). Choose another folder.`);
  }
}

/** Moves a folder, across drives too (a rename fails there). */
async function moveFolder(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    await fs.cp(from, to, { recursive: true, force: false, errorOnExist: false });
    await fs.rm(from, { recursive: true, force: true });
  }
}

/**
 * An admin's choice of Resume folder (null: back to the default). The copies
 * in the old folder are left there (they are built again in the new one as
 * needed), but `kept\` — the only copy of some old Resumes — moves along.
 */
export async function setResumeFolder(requested: string | null): Promise<ResumeFolderInfo> {
  const chosen = requested?.trim() ? requested.trim() : null;
  if (chosen && !path.isAbsolute(chosen)) {
    throw new BadRequestError('Give the Resume folder as a full path on the server, for example C:\\romva\\files.');
  }
  const next = chosen ? path.resolve(chosen) : defaultResumeFolder();
  await assertUsable(next);

  const previous = await resumeFolder();
  if (path.resolve(previous).toLowerCase() !== next.toLowerCase()) {
    const keptFrom = path.join(previous, KEPT_DIR);
    const keptTo = path.join(next, KEPT_DIR);
    if (await exists(keptFrom)) {
      if (await exists(keptTo)) {
        throw new BadRequestError(`"${next}" already has a "${KEPT_DIR}" folder. Move it away first, or choose another folder.`);
      }
      await moveFolder(keptFrom, keptTo);
      logger.info({ from: keptFrom, to: keptTo }, 'Resume folder: moved the kept Resumes');
    }
  }

  await prisma.serverSettings.upsert({
    where: { id: 1 },
    create: { id: 1, resumeFolder: chosen },
    update: { resumeFolder: chosen },
  });
  cached = null;
  return resumeFolderInfo();
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function applicationDir(root: string, bidId: string): string {
  if (!UUID.test(bidId)) throw new Error(`Not an application id: ${bidId}`);
  return path.join(root, bidId);
}

const copyDir = (root: string, bidId: string, kind: DocKind, key: string) =>
  path.join(applicationDir(root, bidId), `${kind}-${key}`);

export interface StoredCopy {
  name: string;
  data: Buffer;
}

/** The copy of one file, or null when it is not in the folder. */
export async function readCopy(bidId: string, kind: DocKind, key: string, format: DocFormat): Promise<StoredCopy | null> {
  const dir = copyDir(await resumeFolder(), bidId, kind, key);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const name = names.find((entry) => entry.toLowerCase().endsWith(`.${format}`));
  if (!name) return null;
  try {
    return { name, data: await fs.readFile(path.join(dir, name)) };
  } catch {
    return null;
  }
}

/**
 * Saves copies under `key`, and removes the application's older copies of the
 * same kind (another key: the Resume or letter changed since). Written to a
 * temporary name first, so a half-written file is never served.
 */
export async function writeCopy(bidId: string, kind: DocKind, key: string, format: DocFormat, file: StoredCopy): Promise<void> {
  const root = await resumeFolder();
  const dir = copyDir(root, bidId, kind, key);
  await fs.mkdir(dir, { recursive: true });
  // One file per format: a renamed one (the Profile's name changed) replaces the old.
  for (const entry of await fs.readdir(dir)) {
    if (entry.toLowerCase().endsWith(`.${format}`) && entry !== file.name) await fs.rm(path.join(dir, entry), { force: true });
  }
  const target = path.join(dir, safeName(file.name, format));
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, file.data);
  await fs.rename(temporary, target);
  await dropOtherKeys(root, bidId, kind, key);
}

async function dropOtherKeys(root: string, bidId: string, kind: DocKind, key: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(applicationDir(root, bidId));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(`${kind}-`) && entry !== `${kind}-${key}`) {
      await fs.rm(path.join(applicationDir(root, bidId), entry), { recursive: true, force: true });
    }
  }
}

/** A file name the folder can hold: what the download is called, without path characters. */
function safeName(name: string, format: DocFormat): string {
  const cleaned = path.basename(name).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.toLowerCase().endsWith(`.${format}`) ? cleaned : `${cleaned || 'file'}.${format}`;
}

/** Deletes an application's copies: one kind, or all of them. Never `kept\`. */
export async function dropCopies(bidId: string, kind?: DocKind): Promise<void> {
  const root = await resumeFolder();
  const dir = applicationDir(root, bidId);
  if (!kind) {
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(`${kind}-`)) await fs.rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

/** `dropCopies` that logs instead of throwing: a copy left behind is cleaned up at night. */
export function dropCopiesQuietly(bidIds: string[], kind?: DocKind): Promise<void> {
  return Promise.all(
    bidIds.map((bidId) =>
      dropCopies(bidId, kind).catch((error) => logger.warn({ err: error, bidId }, 'Resume folder: could not delete copies')),
    ),
  ).then(() => undefined);
}

const keptDir = (root: string, bidId: string) => path.join(root, KEPT_DIR, applicationDir('', bidId));

/** An old Resume's kept file (see `KEPT_DIR`), or null. */
export async function readKept(bidId: string, format: DocFormat): Promise<StoredCopy | null> {
  const dir = keptDir(await resumeFolder(), bidId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const name = names.find((entry) => entry.toLowerCase().endsWith(`.${format}`));
  return name ? { name, data: await fs.readFile(path.join(dir, name)) } : null;
}

export async function keptFormats(bidId: string): Promise<DocFormat[]> {
  try {
    const names = await fs.readdir(keptDir(await resumeFolder(), bidId));
    return (['pdf', 'docx'] as const).filter((format) => names.some((name) => name.toLowerCase().endsWith(`.${format}`)));
  } catch {
    return [];
  }
}

export async function writeKept(bidId: string, format: DocFormat, file: StoredCopy): Promise<void> {
  const dir = keptDir(await resumeFolder(), bidId);
  await fs.mkdir(dir, { recursive: true });
  for (const entry of await fs.readdir(dir)) {
    if (entry.toLowerCase().endsWith(`.${format}`)) await fs.rm(path.join(dir, entry), { force: true });
  }
  await fs.writeFile(path.join(dir, safeName(file.name, format)), file.data);
}

export async function dropKept(bidId: string): Promise<void> {
  await fs.rm(keptDir(await resumeFolder(), bidId), { recursive: true, force: true });
}

/** Every application folder (not `kept\`) in the Resume folder: id → its copy folders with their newest file time. */
export async function listCopies(): Promise<Map<string, { dir: string; modifiedAt: number }[]>> {
  const root = await resumeFolder();
  const found = new Map<string, { dir: string; modifiedAt: number }[]>();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!UUID.test(entry)) continue;
    const appDir = path.join(root, entry);
    const copies: { dir: string; modifiedAt: number }[] = [];
    let subs: string[] = [];
    try {
      subs = await fs.readdir(appDir);
    } catch {
      continue;
    }
    for (const sub of subs) {
      const dir = path.join(appDir, sub);
      let modifiedAt = 0;
      try {
        for (const file of await fs.readdir(dir)) {
          const stat = await fs.stat(path.join(dir, file));
          modifiedAt = Math.max(modifiedAt, stat.mtimeMs);
        }
      } catch {
        continue;
      }
      copies.push({ dir, modifiedAt });
    }
    found.set(entry, copies);
  }
  return found;
}

/** Bytes and files under a folder, for the Storage page (stops counting after `limit` files). */
export async function folderUsage(limit = 200_000): Promise<{ folder: string; bytes: number; files: number; complete: boolean }> {
  const folder = await resumeFolder();
  let bytes = 0;
  let files = 0;
  const stack = [folder];
  while (stack.length && files < limit) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          bytes += (await fs.stat(full)).size;
          files += 1;
        } catch {
          // Deleted meanwhile.
        }
      }
    }
  }
  return { folder, bytes, files, complete: stack.length === 0 };
}
