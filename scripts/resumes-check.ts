/**
 * Where every application's Resume and cover letter is, and whether each one
 * can really be opened. Changes nothing, unless --make.
 *
 *   yarn resumes:check            the report
 *   yarn resumes:check --make     also makes the Word and PDF files that the file
 *                                 rules keep (Draft, the interview statuses,
 *                                 Applied for 20 days) and that are not in the
 *                                 Resume folder yet
 *   option: --profile <Profile id>
 *
 * Every Resume is one of these:
 * - JSON (every new one): its Word and PDF are copies in the Resume folder,
 *   made again from the JSON whenever one is missing, with the template
 *   version it was made with. The check makes sure that version is there.
 * - old, still inside the database: `yarn resumes:to-json --apply` moves it
 *   to the folder.
 * - old, kept as files in the folder's kept\ (it could not be read back into
 *   JSON): those files are its only copy. The check makes sure they are there.
 * - the website's own Resume: made from its page each time.
 * - in a backup (Storage -> Backup and remove): the backup file has it.
 *
 * Files the rules do not keep (Skip, Failed, Expired, Other; Applied after 20
 * days) are not made by --make: the nightly clean-up would delete them again.
 */
import 'dotenv/config';
import path from 'node:path';
import { Prisma as PrismaTypes } from '../src/generated/prisma/client.js';
import { prisma } from '../src/prisma.js';
import { CoverLetterPayloadSchema } from '../src/cover-letter/cover-letter.schemas.js';
import { folderUsage, hasCopy, keptFormats, resumeFolder } from '../src/resume/store/folder.js';
import { keepsCopies } from '../src/resume/store/file-rules.js';
import { letterKey, makeCopies, parseBuild, resumeKey } from '../src/resume/store/resume-store.js';
import { templateVersion } from '../src/resume/store/template-versions.js';

const args = process.argv.slice(2);
const make = args.includes('--make');
const at = args.indexOf('--profile');
const profileId = at >= 0 ? args[at + 1] : undefined;

interface Problem {
  number: number;
  company: string;
  what: string;
}

const line = (text: string, count: number, note = '') =>
  console.log(`  ${text.padEnd(46, '.')} ${String(count).padStart(6)}${note ? `   ${note}` : ''}`);

async function main(): Promise<void> {
  const folder = await resumeFolder();
  const usage = await folderUsage();
  console.log(
    `Resume folder: ${folder}  (${usage.files}${usage.complete ? '' : '+'} files, ${(usage.bytes / 1024 / 1024).toFixed(1)} MB)`,
  );

  const where: PrismaTypes.BidWhereInput = profileId ? { profileId } : {};
  const rows = await prisma.bid.findMany({
    where,
    select: {
      id: true,
      number: true,
      company: true,
      status: true,
      appliedAt: true,
      bidDate: true,
      profileId: true,
      backedUpAt: true,
      resumeAnswer: true,
      resumeBuild: true,
      resumeKept: true,
      coverLetterDocument: true,
      resumeFiles: { select: { format: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  // Only whether the website's own Resume is there, not the document itself.
  const websiteIds = new Set(
    (
      await prisma.bid.findMany({ where: { ...where, resumeDocument: { not: PrismaTypes.AnyNull } }, select: { id: true } })
    ).map((row) => row.id),
  );

  const count = {
    json: 0,
    jsonInFolder: 0,
    jsonMissing: 0,
    jsonMissingKept: 0,
    oldInDatabase: 0,
    kept: 0,
    website: 0,
    inBackup: 0,
    none: 0,
    letters: 0,
    lettersInFolder: 0,
  };
  const problems: Problem[] = [];
  const toMake = new Set<string>();
  // Template versions, looked up once each.
  const templates = new Map<string, Promise<boolean>>();
  const templateThere = (hash: string | undefined, id: string) => {
    const key = `${hash ?? ''}|${id}`;
    if (!templates.has(key)) templates.set(key, templateVersion(hash, id).then(() => true, () => false));
    return templates.get(key)!;
  };

  for (const row of rows) {
    const keeps = keepsCopies(row.status, row.appliedAt);
    const build = parseBuild(row.resumeBuild);
    if (row.resumeAnswer !== null) {
      count.json += 1;
      if (!build) {
        problems.push({ number: row.number, company: row.company, what: 'Resume JSON without its build details: cannot be made' });
      } else {
        if (!(await templateThere(build.templateSha256, build.templateId))) {
          problems.push({ number: row.number, company: row.company, what: `template "${build.templateId}" is missing: cannot be made` });
        }
        if (await hasCopy(row.id, 'resume', resumeKey(row.resumeAnswer, build))) count.jsonInFolder += 1;
        else {
          count.jsonMissing += 1;
          if (keeps) {
            count.jsonMissingKept += 1;
            toMake.add(row.id);
          }
        }
      }
    } else if (row.resumeFiles.length > 0) {
      count.oldInDatabase += 1;
    } else if (row.resumeKept) {
      count.kept += 1;
      if ((await keptFormats(row.id)).length === 0) {
        problems.push({ number: row.number, company: row.company, what: `its files are missing from ${path.join(folder, 'kept', row.id)}` });
      }
    } else if (websiteIds.has(row.id)) {
      count.website += 1;
    } else if (row.backedUpAt) {
      count.inBackup += 1;
    } else {
      count.none += 1;
    }

    const letter = CoverLetterPayloadSchema.safeParse(row.coverLetterDocument);
    if (letter.success) {
      count.letters += 1;
      const key = letterKey(letter.data, row.bidDate.toISOString().slice(0, 10), row.profileId);
      if (await hasCopy(row.id, 'cover-letter', key)) count.lettersInFolder += 1;
      else if (keeps) toMake.add(row.id);
    }
  }

  console.log('');
  console.log(`${rows.length} applications${profileId ? ` (Profile ${profileId})` : ''}`);
  line('Resume as JSON', count.json);
  line('   Word/PDF in the folder', count.jsonInFolder);
  line('   not in the folder (made when opened)', count.jsonMissing, count.jsonMissingKept ? `${count.jsonMissingKept} of them should be there by the rules` : '');
  line('Old Resume, still inside the database', count.oldInDatabase, count.oldInDatabase ? 'yarn resumes:to-json --apply moves them to the folder' : '');
  line('Old Resume, kept as files (kept\\)', count.kept);
  line("The website's own Resume", count.website);
  line('In a backup (removed from the database)', count.inBackup);
  line('No Resume', count.none);
  line('Cover letters (JSON)', count.letters);
  line('   Word/PDF in the folder', count.lettersInFolder);

  console.log('');
  if (problems.length === 0) {
    console.log('Problems: none. Every Resume can be opened.');
  } else {
    console.log(`PROBLEMS: ${problems.length} Resume(s) cannot be opened:`);
    for (const problem of problems.slice(0, 30)) console.log(`  #${problem.number} ${problem.company}: ${problem.what}`);
    if (problems.length > 30) console.log(`  … and ${problems.length - 30} more`);
  }

  if (!make) {
    if (toMake.size > 0) {
      console.log('');
      console.log(`${toMake.size} application(s) should have their files in the folder by the rules. To make them now:`);
      console.log('  yarn resumes:check --make');
    }
    return;
  }

  console.log('');
  console.log(`Making the files of ${toMake.size} application(s)…`);
  let made = 0;
  let failed = 0;
  let done = 0;
  for (const bidId of toMake) {
    try {
      await makeCopies(bidId);
      made += 1;
    } catch (error) {
      failed += 1;
      console.log(`  could not make ${bidId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    done += 1;
    if (done % 25 === 0 || done === toMake.size) console.log(`  ${done}/${toMake.size}: ${made} made, ${failed} failed`);
  }
  console.log(`Done: ${made} made, ${failed} failed.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
