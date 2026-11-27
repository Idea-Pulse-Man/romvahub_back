import { createHash } from 'node:crypto';
import { prisma } from '../../prisma.js';
import { readTemplateBytes } from '../maker/templates.js';

/**
 * Each Resume keeps the hash of the template version it was made with
 * (`Bid.resumeBuild.templateSha256`), and that version's bytes are kept in
 * `resume_template_versions`: a template uploaded again under the same name
 * replaces the old one in `resume_templates`, and a Resume built again later
 * must still look like the one that was sent.
 */

export interface TemplateBytes {
  id: string;
  bytes: Buffer;
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A few versions in memory: "Make files" builds many Resumes from the same template. */
const recent = new Map<string, TemplateBytes>();
const RECENT_MAX = 16;

function remember(hash: string, template: TemplateBytes): void {
  recent.delete(hash);
  recent.set(hash, template);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
}

/** Keeps this version (once) and returns its hash. */
export async function keepTemplateVersion(template: TemplateBytes): Promise<string> {
  const hash = sha256(template.bytes);
  if (recent.has(hash)) return hash;
  const stored = await prisma.resumeTemplateVersion.findUnique({ where: { sha256: hash }, select: { sha256: true } });
  if (!stored) {
    await prisma.resumeTemplateVersion
      .create({ data: { sha256: hash, templateId: template.id, data: new Uint8Array(template.bytes) } })
      // Two Resumes saved at once with a new version: the other one stored it.
      .catch(async (error) => {
        const again = await prisma.resumeTemplateVersion.findUnique({ where: { sha256: hash }, select: { sha256: true } });
        if (!again) throw error;
      });
  }
  remember(hash, template);
  return hash;
}

/** The template a Resume was made with: its kept version, else (an older Resume) the template by name now. */
export async function templateVersion(hash: string | undefined, templateId: string | undefined): Promise<TemplateBytes> {
  if (hash) {
    const known = recent.get(hash);
    if (known) return known;
    const row = await prisma.resumeTemplateVersion.findUnique({ where: { sha256: hash }, select: { templateId: true, data: true } });
    if (row) {
      const template = { id: row.templateId, bytes: Buffer.from(row.data) };
      remember(hash, template);
      return template;
    }
  }
  return readTemplateBytes(templateId);
}
