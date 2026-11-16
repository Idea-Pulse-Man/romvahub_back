/**
 * Fingerprints the proof screenshots uploaded before fingerprints existed.
 *
 *   yarn proofs:fingerprint
 *   DATABASE_URL='postgresql://…' AWS_… yarn proofs:fingerprint
 *
 * A new upload is fingerprinted as it passes through `POST /api/bids/:id/proof`
 * (see `src/proof/fingerprint.ts`), but the screenshots already in the bucket
 * were never looked at, and a duplicate check that only knows about uploads
 * made after it was switched on would miss the copies it was switched on to
 * find. This reads each such screenshot back once and stores what is in it.
 *
 * Idempotent and resumable: only rows with a screenshot and no fingerprint of
 * the current version are touched — none at all, or one an earlier version of
 * the method wrote — so a run that stops halfway is finished by running it
 * again, and a change of method is rolled out by running it once more. A
 * screenshot that cannot be fetched or decoded is logged and skipped, and
 * remains without a fingerprint — it does not stop the run. Nothing is deleted
 * and no screenshot is rewritten.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { downloadObject } from '../src/storage/s3.client.js';
import { fingerprintImage, parseFingerprint } from '../src/proof/fingerprint.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main(): Promise<void> {
  const withProof = await prisma.bid.findMany({
    where: { proofKey: { not: null } },
    select: { id: true, proofKey: true, proofFingerprint: true },
    orderBy: { createdAt: 'asc' },
  });
  const rows = withProof.filter((row) => parseFingerprint(row.proofFingerprint) === null);
  console.log(`${rows.length} of ${withProof.length} screenshot(s) to fingerprint.`);

  let done = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const image = await downloadObject(row.proofKey as string);
      const fingerprint = await fingerprintImage(image);
      await prisma.bid.update({ where: { id: row.id }, data: { proofFingerprint: { ...fingerprint } } });
      done += 1;
    } catch (error) {
      skipped += 1;
      console.warn(`skipped ${row.id} (${row.proofKey}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`Fingerprinted ${done}, skipped ${skipped}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
