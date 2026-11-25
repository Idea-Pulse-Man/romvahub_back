/**
 * Copies every photo and proof screenshot still in the S3 bucket into this
 * server's database (`stored_files`), so nothing depends on the bucket.
 *
 *   yarn files:to-db        (with the AWS_… settings still in .env)
 *
 * Idempotent: files already in the database are skipped, so it can be run
 * again after a stop. A file the bucket no longer has is logged and skipped.
 * Nothing is deleted from the bucket.
 */
import 'dotenv/config';
import { prisma } from '../src/prisma.js';
import { env } from '../src/env.js';
import { readStoredFile } from '../src/storage/s3.client.js';

async function main(): Promise<void> {
  if (!env.storageEnabled) {
    console.error('The AWS_… bucket settings are not set, so there is no bucket to copy from.');
    process.exit(1);
  }
  const photos = await prisma.profile.findMany({ where: { photoKey: { not: null } }, select: { photoKey: true } });
  const proofs = await prisma.bid.findMany({ where: { proofKey: { not: null } }, select: { proofKey: true } });
  const keys = [...new Set([...photos.map((p) => p.photoKey), ...proofs.map((b) => b.proofKey)])].filter(
    (key): key is string => Boolean(key),
  );
  const have = new Set(
    (await prisma.storedFile.findMany({ where: { key: { in: keys } }, select: { key: true } })).map((f) => f.key),
  );
  let copied = 0;
  let missing = 0;
  for (const key of keys) {
    if (have.has(key)) continue;
    const file = await readStoredFile(key); // copies it into the database
    if (file) copied += 1;
    else {
      missing += 1;
      console.warn(`Not in the bucket: ${key}`);
    }
  }
  console.log(`${keys.length} files: ${have.size} already here, ${copied} copied, ${missing} missing.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
