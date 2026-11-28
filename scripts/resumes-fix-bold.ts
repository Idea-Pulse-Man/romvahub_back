/**
 * Resumes whose JSON has bold written twice over (`**[text][highlight]**` or
 * `[**text**][highlight]`) were built with the inner brackets showing in the
 * Word and PDF. The build now strips the inner markup (merge-docx `plainBold`);
 * this deletes those Resumes' stored Word and PDF copies, so each is made again
 * from its JSON, correctly, the next time it is opened. The JSON is not changed.
 *
 *   yarn resumes:fix-bold            lists them
 *   yarn resumes:fix-bold --apply    deletes their copies
 */
import 'dotenv/config';
import { prisma } from '../src/prisma.js';
import { dropCopies } from '../src/resume/store/folder.js';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  // Matched in the database, so only the matching applications come back (not every Resume's JSON).
  const rows = await prisma.$queryRaw<{ id: string; number: number; company: string }[]>`
    SELECT "id", "number", "company" FROM "bids"
    WHERE "resumeAnswer" IS NOT NULL
      AND ("resumeAnswer"::text LIKE '%][highlight]**%' OR "resumeAnswer"::text LIKE '%[**%')
    ORDER BY "number"`;
  console.log(`${rows.length} Resume(s) with bold written twice:`);
  for (const row of rows) console.log(`  #${row.number}  ${row.company}`);
  if (!rows.length) return;
  if (!apply) {
    console.log('\nNothing changed. Run again with --apply to have these made again (correctly) when next opened.');
    return;
  }
  for (const row of rows) await dropCopies(row.id, 'resume');
  console.log(`\nDone: their Word and PDF copies are deleted, and are made again from the JSON when next opened.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
