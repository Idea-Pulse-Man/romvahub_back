/**
 * Candidate photos, in an S3-compatible bucket.
 *
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
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';
import { ServiceUnavailableError } from '../http/errors.js';
import { logger } from '../logger.js';

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
  const bucket = s3();

  await bucket.send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      // The bucket stays private; the app hands out signed URLs instead. Said
      // explicitly so a bucket whose default ACL is public does not quietly
      // make every candidate photo world-readable.
      ACL: 'private',
    }),
  );

  return { key, url: (await signPhotoUrl(key)) as string };
}

/**
 * A short-lived GET URL for a stored photo, or `undefined` when there is no
 * photo — or when storage is switched off in this deployment.
 *
 * Returning `undefined` rather than throwing for the unconfigured case is
 * deliberate: this is called while reading a profile, and a deployment with no
 * bucket should still be able to load Settings.
 */
export async function signPhotoUrl(key: string | null | undefined): Promise<string | undefined> {
  if (!key || !env.storageEnabled) return undefined;

  try {
    return await getSignedUrl(
      s3(),
      new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }),
      { expiresIn: env.S3_SIGNED_URL_TTL_SECONDS },
    );
  } catch (error) {
    // Signing is local arithmetic, so this is a misconfiguration rather than a
    // network failure — and it must not take the whole profile down with it.
    logger.error({ err: error, key }, 'Could not sign a photo URL');
    return undefined;
  }
}

/**
 * The bytes of a stored object. For the backfill that fingerprints the proof
 * screenshots uploaded before fingerprints existed; the request path never
 * reads a screenshot back, it fingerprints the upload as it passes through.
 */
export async function downloadObject(key: string): Promise<Buffer> {
  const response = await s3().send(new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }));
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) throw new Error(`The bucket answered with no body for ${key}.`);
  return Buffer.from(bytes);
}

/**
 * Removes a stored photo. Failures are logged and swallowed: this runs after
 * the profile row has already stopped pointing at the object, so the only cost
 * of a failed delete is an orphan in the bucket — not a broken request.
 */
export async function deletePhoto(key: string | null | undefined): Promise<void> {
  if (!key || !env.storageEnabled) return;

  try {
    await s3().send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }));
  } catch (error) {
    logger.warn({ err: error, key }, 'Could not delete a replaced photo from the bucket');
  }
}
