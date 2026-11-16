/**
 * DOCX templates for Maker mail-merge.
 *
 * Two sources, read together:
 *
 * - **The database** (`resume_templates`): every uploaded template. Shared by
 *   every server — a hosted deployment, the desktop app, `yarn dev` — and kept
 *   across deploys, which a hosted server's file system is not.
 * - **Built-in files** under `assets/resume-templates/` at the backend root:
 *   `default.docx`, the fallback that is never deleted, and anything shipped
 *   with the code. Read-only.
 *
 * A database template with the same name as a built-in file wins.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BadRequestError, NotFoundError } from '../../http/errors.js';
import { prisma } from '../../prisma.js';

const DEFAULT_ID = 'default.docx';
const TEMPLATES_DIR_NAME = 'resume-templates';

/** Resolve `…/remote-ops-backend/assets/resume-templates` from this module. */
export function templatesDirectory(): string {
  // src/resume/maker (or dist/resume/maker) → ../../../assets/resume-templates
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'assets', TEMPLATES_DIR_NAME);
}

function isSafeTemplateId(id: string): boolean {
  // Single path segment only: no traversal, no nested folders.
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.docx$/i.test(id);
}

const isDefault = (id: string) => id.toLowerCase() === DEFAULT_ID.toLowerCase();

export interface TemplateInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

const info = (id: string): TemplateInfo => ({ id, name: id.replace(/\.docx$/i, ''), isDefault: isDefault(id) });

async function builtInIds(): Promise<string[]> {
  try {
    return (await fs.readdir(templatesDirectory())).filter(isSafeTemplateId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function listTemplates(): Promise<TemplateInfo[]> {
  const [files, rows] = await Promise.all([
    builtInIds(),
    prisma.resumeTemplate.findMany({ select: { id: true } }),
  ]);
  const ids = new Map<string, string>();
  for (const id of [...files, ...rows.map((row) => row.id)]) ids.set(id.toLowerCase(), id);
  return [...ids.values()]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(info);
}

function cleanId(requested?: string): string {
  const id = (requested?.trim() || DEFAULT_ID).replace(/^.*[/\\]/, '');
  if (!isSafeTemplateId(id)) {
    throw new BadRequestError('That is not a valid template file name.');
  }
  return id;
}

/** The template's bytes from the database, or from the built-in files; `null` when neither has it. */
async function loadTemplate(id: string): Promise<{ id: string; bytes: Buffer } | null> {
  const row = await prisma.resumeTemplate.findFirst({
    where: { id: { equals: id, mode: 'insensitive' } },
    select: { id: true, data: true },
  });
  if (row) return { id: row.id, bytes: Buffer.from(row.data) };
  try {
    return { id, bytes: await fs.readFile(path.join(templatesDirectory(), id)) };
  } catch {
    return null;
  }
}

function missing(id: string): NotFoundError {
  return isDefault(id)
    ? new NotFoundError('The default Resume template is missing from the server. Ask an administrator to restore it.')
    : new NotFoundError(`Template "${id}" was not found.`);
}

export async function resolveTemplateId(requested?: string): Promise<string> {
  const id = cleanId(requested);
  const row = await prisma.resumeTemplate.findFirst({
    where: { id: { equals: id, mode: 'insensitive' } },
    select: { id: true },
  });
  if (row) return row.id;
  try {
    await fs.access(path.join(templatesDirectory(), id));
    return id;
  } catch {
    throw missing(id);
  }
}

export async function readTemplateBytes(templateId?: string): Promise<{ id: string; bytes: Buffer }> {
  const id = cleanId(templateId);
  const template = await loadTemplate(id);
  if (!template) throw missing(id);
  if (!template.bytes.length) {
    throw new BadRequestError(`Template "${template.id}" is empty.`);
  }
  return template;
}

export async function saveUploadedTemplate(originalName: string, bytes: Buffer): Promise<TemplateInfo> {
  if (!bytes.length) {
    throw new BadRequestError('The uploaded template is empty.');
  }

  const base = path.basename(originalName).replace(/[^\w.\-]+/g, '_');
  const withExt = /\.docx$/i.test(base) ? base : `${base}.docx`;
  if (!isSafeTemplateId(withExt)) {
    throw new BadRequestError(
      'Template file names must be .docx and use letters, numbers, dots, dashes or underscores.',
    );
  }

  // Re-uploading a name replaces it (whatever its case).
  const existing = await prisma.resumeTemplate.findFirst({
    where: { id: { equals: withExt, mode: 'insensitive' } },
    select: { id: true },
  });
  const id = existing?.id ?? withExt;
  await prisma.resumeTemplate.upsert({
    where: { id },
    create: { id, data: new Uint8Array(bytes) },
    update: { data: new Uint8Array(bytes) },
  });
  return info(id);
}

export async function deleteTemplate(templateId: string): Promise<void> {
  const id = await resolveTemplateId(templateId);
  if (isDefault(id)) {
    throw new BadRequestError('The default template cannot be deleted.');
  }
  const { count } = await prisma.resumeTemplate.deleteMany({ where: { id } });
  if (count === 0) {
    throw new BadRequestError(`"${id}" is built into the app and cannot be deleted here.`);
  }
}
