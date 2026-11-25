/**
 * Candidate photos and proof screenshots, kept in this server's own database
 * (`stored_files`) and served through signed `/api/files/…` links.
 *
 * The S3 settings below are only for files uploaded before that: when they are
 * set, a file missing from the database is read from the bucket once and copied
 * in (see `readStoredFile`, and `scripts/move-files-to-db.ts` to copy them all).
 *
 * Former notes on the bucket:
 * Written against an explicit `AWS_ENDPOINT_URL_S3` rather than AWS's own
 * region host, so the same five variables point at Tigris, R2, MinIO or plain
 * AWS without a code change. `forcePathStyle` is what makes the non-AWS ones
 * work: they address a bucket as `endpoint/bucket/key`, not as a subdomain.
 *
 * Nothing here is created at import time. A deployment with no storage
 * configured must still serve every other route, so the client is built on
 * first use and `s3()` is what turns "not switched on" into a 503 naming the
 * variables it wanted.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../env.js';
import { ServiceUnavailableError } from '../http/errors.js';
import { logger } from '../logger.js';
import { prisma } from '../prisma.js';

/** What a photo may be. Anything else is a 400 before a byte reaches the bucket. */
export const PHOTO_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

/** 5 MB. A profile photo that needs more than this is a photo of something else. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const EXTENSION_FOR: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

let client: S3Client | null = null;

/**
 * The client, built on first use. Returning it rather than narrowing a module
 * variable is what lets callers use it without a null check — a TypeScript
 * `asserts` signature can only narrow a parameter, not a module binding.
 */
function s3(): S3Client {
  if (!env.storageEnabled) {
    throw new ServiceUnavailableError(
      'Photo storage is not configured. Set AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, ' +
        'AWS_SECRET_ACCESS_KEY, AWS_REGION and AWS_S3_BUCKET.',
    );
  }

  client ??= new S3Client({
    region: env.AWS_REGION,
    endpoint: env.AWS_ENDPOINT_URL_S3,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY as string,
    },
  });

  return client;
}

/**
 * Where one user's photo lives.
 *
 * A fresh random suffix on every upload rather than a stable `photos/<userId>`:
 * overwriting one key would leave every browser and CDN that already fetched it
 * showing the old picture until its cache expired, and the old object is
 * deleted straight after the new key is written anyway.
 */
function photoKeyFor(userId: string, contentType: string): string {
  return `photos/${userId}/${randomUUID()}.${EXTENSION_FOR[contentType] ?? 'bin'}`;
}

/**
 * Where one application's proof screenshot lives — the job site's "thank you
 * for applying" page. Under the bid rather than the user, so deleting the
 * application names everything to remove; a fresh suffix per upload for the
 * same reason the photo gets one.
 */
function proofKeyFor(bidId: string, contentType: string): string {
  return `proofs/${bidId}/${randomUUID()}.${EXTENSION_FOR[contentType] ?? 'bin'}`;
}

export interface UploadedPhoto {
  key: string;
  url: string;
}

/** Stores a photo and returns its key plus a signed URL for immediate display. */
export async function uploadPhoto(
  userId: string,
  body: Buffer,
  contentType: string,
): Promise<UploadedPhoto> {
  return putObject(photoKeyFor(userId, contentType), body, contentType);
}

/**
 * Stores an application's proof screenshot. The same bucket, the same private
 * ACL and the same signed reads as a photo: a screenshot of a confirmation
 * page carries the candidate's name and the employer's, and is nobody else's
 * business.
 */
export async function uploadProof(
  bidId: string,
  body: Buffer,
  contentType: string,
): Promise<UploadedPhoto> {
  return putObject(proofKeyFor(bidId, contentType), body, contentType);
}

async function putObject(key: string, body: Buffer, contentType: string): Promise<UploadedPhoto> {
  await prisma.storedFile.create({ data: { key, contentType, size: body.length, bytes: new Uint8Array(body) } });
  return { key, url: (await signPhotoUrl(key)) as string };
}

/** The HMAC that makes a `/api/files/…` link work until `expires` (seconds). */
export function fileSignature(key: string, expires: number): string {
  return createHmac('sha256', env.JWT_ACCESS_SECRET).update(`file:${key}:${expires}`).digest('base64url');
}

/** True when a `/api/files/…` link's signature matches and it has not expired. */
export function verifyFileSignature(key: string, expires: number, signature: string): boolean {
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
  const want = Buffer.from(fileSignature(key, expires));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * A short-lived GET link for a stored photo or screenshot, or `undefined` when
 * there is none. Relative (`/api/files/…`): the website is served by this same
 * server, and the desktop app puts its server address in front.
 *
 * The expiry is rounded to the hour so the link stays the same for a while and
 * the browser cache keeps working.
 */
export async function signPhotoUrl(key: string | null | undefined): Promise<string | undefined> {
  if (!key) return undefined;
  const ttl = env.S3_SIGNED_URL_TTL_SECONDS;
  const expires = Math.ceil((Date.now() / 1000 + ttl) / 3600) * 3600;
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `/api/files/${path}?e=${expires}&s=${fileSignature(key, expires)}`;
}

/**
 * A stored file: from this database, or — for a file uploaded while photos
 * still lived in the S3 bucket — from the bucket, copied into the database on
 * the way so it is read from here next time. `null` when it exists nowhere.
 */
export async function readStoredFile(key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const row = await prisma.storedFile.findUnique({ where: { key }, select: { bytes: true, contentType: true } });
  if (row) return { bytes: Buffer.from(row.bytes), contentType: row.contentType };
  if (!env.storageEnabled) return null;
  try {
    const response = await s3().send(new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }));
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) return null;
    const contentType = response.ContentType ?? 'application/octet-stream';
    const body = Buffer.from(bytes);
    await prisma.storedFile
      .upsert({ where: { key }, create: { key, contentType, size: body.length, bytes: new Uint8Array(body) }, update: {} })
      .catch((error: unknown) => logger.warn({ err: error, key }, 'Could not copy a bucket file into the database'));
    return { bytes: body, contentType };
  } catch (error) {
    logger.warn({ err: error, key }, 'A stored file is in neither the database nor the bucket');
    return null;
  }
}

/** The bytes of a stored file (for the proof fingerprint backfill). */
export async function downloadObject(key: string): Promise<Buffer> {
  const file = await readStoredFile(key);
  if (!file) throw new Error(`No stored file ${key}.`);
  return file.bytes;
}

/**
 * Removes a stored photo or screenshot. Failures are logged and swallowed: this
 * runs after the row has already stopped pointing at the file, so the only cost
 * of a failed delete is an orphan, not a broken request.
 */
export async function deletePhoto(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await prisma.storedFile.deleteMany({ where: { key } });
  } catch (error) {
    logger.warn({ err: error, key }, 'Could not delete a replaced file from the database');
  }
  if (!env.storageEnabled) return;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }));
  } catch (error) {
    logger.warn({ err: error, key }, 'Could not delete a replaced photo from the bucket');
  }
}
