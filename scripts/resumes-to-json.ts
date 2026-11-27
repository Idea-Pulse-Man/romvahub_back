/**
 * Turns the old Resumes — Word and PDF files stored in the database
 * (`bid_resume_files`) — into JSON, the way every new Resume is kept, so the
 * database stops holding files.
 *
 *   yarn resumes:to-json                 test run: changes nothing, writes a report
 *   yarn resumes:to-json --apply         does it
 *   options: --limit 100   --profile <Profile id>   --no-compact
 *
 * For each old Resume, its Word file is read back into the JSON it was made
 * from (`src/resume/store/from-docx.ts`), trying the Profile's template first
 * and then every other template the server has. It is accepted only when the
 * Resume built again from that JSON is the same, paragraph by paragraph.
 *
 * - Changed to JSON: the JSON goes on the application; the original Word and
 *   PDF files go to the Resume folder as its copies (the very files that were
 *   sent); the database rows go.
 * - Cannot be changed: its original files move to the Resume folder's `kept\`
 *   folder (copy that folder when moving the server); the database rows go.
 *
 * With --apply, the files table is compacted at the end so the database
 * really gets smaller. Safe to run again: only Resumes still in the table are
 * looked at.
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Prisma as PrismaTypes } from '../src/generated/prisma/client.js';
import { prisma } from '../src/prisma.js';
import { readKept, resumeFolder, writeCopy, writeKept } from '../src/resume/store/folder.js';
import { jsonFromDocx } from '../src/resume/store/from-docx.js';
import { resumeKey, stemFor, type ResumeBuild } from '../src/resume/store/resume-store.js';
import { keepTemplateVersion, sha256 } from '../src/resume/store/template-versions.js';
import { templatesDirectory } from '../src/resume/maker/templates.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const compact = !args.includes('--no-compact');
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const limit = Number(option('--limit')) || Infinity;
const profileId = option('--profile');

interface Template {
  id: string;
  bytes: Buffer;
}

/** Every template the server has: uploaded ones, built-in ones, and every version a Resume was made with. */
async function allTemplates(): Promise<Template[]> {
  const found = new Map<string, Template>();
  const add = (id: string, bytes: Buffer) => {
    const hash = sha256(bytes);
    if (!found.has(hash)) found.set(hash, { id, bytes });
  };
  for (const row of await prisma.resumeTemplate.findMany({ select: { id: true, data: true } })) add(row.id, Buffer.from(row.data));
  try {
    for (const name of await fs.readdir(templatesDirectory())) {
      if (name.toLowerCase().endsWith('.docx')) add(name, await fs.readFile(path.join(templatesDirectory(), name)));
    }
  } catch {
    // No built-in templates.
  }
  for (const row of await prisma.resumeTemplateVersion.findMany({ select: { templateId: true, data: true } })) {
    add(row.templateId, Buffer.from(row.data));
  }
  return [...found.values()];
}

const stemOf = (fileName: string | undefined) => fileName?.replace(/_resume\.(docx|pdf)$/i, '') ?? '';

async function main(): Promise<void> {
  const templates = await allTemplates();
  console.log(`${apply ? 'APPLY' : 'TEST RUN (nothing is changed)'} — ${templates.length} templates; Resume folder: ${await resumeFolder()}`);

  const candidates = await prisma.bid.findMany({
    where: {
      resumeFiles: { some: { format: 'docx' } },
      resumeAnswer: { equals: PrismaTypes.AnyNull },
      ...(profileId ? { profileId } : {}),
    },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const ids = candidates.map((row) => row.id).slice(0, limit);
  // Old Resumes with only a PDF can never be read back: they go to kept\ as they are.
  const pdfOnly = (
    await prisma.bid.findMany({
      where: {
        resumeFiles: { some: { format: 'pdf' }, none: { format: 'docx' } },
        resumeAnswer: { equals: PrismaTypes.AnyNull },
        ...(profileId ? { profileId } : {}),
      },
      select: { id: true },
    })
  ).map((row) => row.id);
  console.log(`${ids.length} old Resumes with a Word file, ${pdfOnly.length} with only a PDF.`);

  const report = {
    startedAt: new Date().toISOString(),
    apply,
    converted: 0,
    kept: 0,
    byTemplate: {} as Record<string, number>,
    notConverted: [] as { bidId: string; number: number; company: string; reason: string }[],
  };

  const started = Date.now();
  for (let i = 0; i < ids.length; i += 1) {
    const bidId = ids[i]!;
    const row = await prisma.bid.findUnique({
      where: { id: bidId },
      select: {
        id: true,
        number: true,
        company: true,
        profile: { select: { firstName: true, lastName: true, resumeTemplateId: true } },
        user: { select: { profile: { select: { firstName: true, lastName: true, resumeTemplateId: true } } } },
        resumeFiles: { select: { format: true, name: true, data: true } },
      },
    });
    if (!row) continue;
    const docx = row.resumeFiles.find((file) => file.format === 'docx');
    const pdf = row.resumeFiles.find((file) => file.format === 'pdf');
    if (!docx) continue;

    // The Profile's own template first, then every other one.
    const own = (row.profile ?? row.user?.profile)?.resumeTemplateId?.toLowerCase();
    const ordered = [...templates].sort((a, b) => Number(b.id.toLowerCase() === own) - Number(a.id.toLowerCase() === own));
    let found: { template: Template; json: Record<string, string> } | null = null;
    let reason = 'no template';
    for (const template of ordered) {
      const result = await jsonFromDocx(Buffer.from(docx.data), template.bytes);
      if (result.ok) {
        found = { template, json: result.json };
        break;
      }
      if (template === ordered[0]) reason = result.reason;
    }

    const stem = stemOf(docx.name) || stemFor({ company: row.company, profile: row.profile, user: row.user });
    if (found) {
      report.converted += 1;
      report.byTemplate[found.template.id] = (report.byTemplate[found.template.id] ?? 0) + 1;
      if (apply) {
        const templateSha256 = await keepTemplateVersion(found.template);
        const build: ResumeBuild = { kind: 'maker', templateId: found.template.id, templateSha256, stem };
        const key = resumeKey(found.json, build);
        // The very files that were sent, as its copies.
        await writeCopy(bidId, 'resume', key, 'docx', { name: `${stem}_resume.docx`, data: Buffer.from(docx.data) });
        if (pdf) await writeCopy(bidId, 'resume', key, 'pdf', { name: `${stem}_resume.pdf`, data: Buffer.from(pdf.data) });
        await prisma.$transaction([
          prisma.bid.update({
            where: { id: bidId },
            data: {
              resumeAnswer: found.json as PrismaTypes.InputJsonValue,
              resumeBuild: build as unknown as PrismaTypes.InputJsonValue,
              resumeKept: false,
            },
          }),
          prisma.bidResumeFile.deleteMany({ where: { bidId } }),
        ]);
      }
    } else {
      report.kept += 1;
      report.notConverted.push({ bidId, number: row.number, company: row.company, reason });
      if (apply) await keep(bidId, row.resumeFiles);
    }

    if ((i + 1) % 50 === 0 || i === ids.length - 1) {
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`${i + 1}/${ids.length}: ${report.converted} changed to JSON, ${report.kept} not (${seconds} s)`);
    }
  }

  for (const bidId of pdfOnly) {
    report.kept += 1;
    report.notConverted.push({ bidId, number: 0, company: '', reason: 'only a PDF was stored' });
    if (!apply) continue;
    const files = await prisma.bidResumeFile.findMany({ where: { bidId }, select: { format: true, name: true, data: true } });
    await keep(bidId, files);
  }

  if (apply && compact) {
    console.log('Compacting the files table (VACUUM FULL)…');
    await prisma.$executeRawUnsafe('VACUUM FULL "bid_resume_files"');
    await prisma.$executeRawUnsafe('VACUUM FULL "bids"');
  }

  const reportFile = path.resolve(`resumes-to-json-report-${apply ? 'apply' : 'test'}-${Date.now()}.json`);
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(
    `Done: ${report.converted} changed to JSON, ${report.kept} ${apply ? 'moved to kept\\' : 'would go to kept\\'}. ` +
      `By template: ${JSON.stringify(report.byTemplate)}. Report: ${reportFile}`,
  );
}

/** Its original files to kept\, checked there, then the database rows go. */
async function keep(bidId: string, files: { format: string; name: string; data: Uint8Array }[]): Promise<void> {
  for (const file of files) {
    if (file.format !== 'pdf' && file.format !== 'docx') continue;
    await writeKept(bidId, file.format, { name: file.name, data: Buffer.from(file.data) });
    const back = await readKept(bidId, file.format);
    if (!back || back.data.byteLength !== file.data.byteLength) throw new Error(`Could not keep ${file.name} for ${bidId}`);
  }
  await prisma.$transaction([
    prisma.bid.update({ where: { id: bidId }, data: { resumeKept: true } }),
    prisma.bidResumeFile.deleteMany({ where: { bidId } }),
  ]);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
