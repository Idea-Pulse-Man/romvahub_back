/**
 * Encryption for the few secrets that have to live in the database.
 *
 * Only the AI API key needs this today. The requirement it answers is narrow:
 * an admin types a key into a form, the server must be able to use it later,
 * and a copy of the database must not be a copy of the key.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt rather than decrypting
 * to something else. The stored form is `iv:authTag:ciphertext`, each part
 * base64 — self-describing enough that a value can be identified in a database
 * dump without a schema to hand.
 *
 * This is encryption at rest against a leaked dump or a careless backup. It is
 * not protection from someone who already has the application's environment:
 * anything that can read `CONFIG_ENCRYPTION_KEY` can read the key itself. A
 * deployment that needs more than that wants a KMS, not this file.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

/**
 * The 32-byte key, derived once.
 *
 * `CONFIG_ENCRYPTION_KEY` is the explicit answer and the one to use. Without
 * it, the key is derived from `JWT_ACCESS_SECRET` — which every deployment
 * already has, and which is already the thing that must not leak — so this
 * works out of the box rather than making the feature depend on a variable
 * nobody set. The cost of that fallback is that rotating the JWT secret makes a
 * stored key undecryptable; the info string below is what keeps the derived key
 * from colliding with any other use of that secret.
 */
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const explicit = env.CONFIG_ENCRYPTION_KEY?.trim();
  if (explicit) {
    // Accepted as base64 or as raw text; either way it is stretched to exactly
    // 32 bytes rather than trusted to be the right length.
    const material = /^[A-Za-z0-9+/=]+$/.test(explicit)
      ? Buffer.from(explicit, 'base64')
      : Buffer.from(explicit, 'utf8');
    cachedKey = Buffer.from(
      // Salt is a key-derivation constant, not a product name — changing it
      // would make every stored API key undecryptable.
      hkdfSync('sha256', material, 'global-eyes-config-salt', 'config-secret', KEY_BYTES),
    );
    return cachedKey;
  }

  cachedKey = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(env.JWT_ACCESS_SECRET, 'utf8'),
      'global-eyes-config-salt',
      'config-secret-derived-from-jwt',
      KEY_BYTES,
    ),
  );
  return cachedKey;
}

/** `iv:authTag:ciphertext`, each part base64. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

/**
 * The plaintext, or `null` when the stored value cannot be read — a truncated
 * column, or a key that has been rotated out from under it.
 *
 * Null rather than a throw because every caller is deciding whether a usable
 * key exists, and "stored but unreadable" is the same answer as "not stored" to
 * all of them. The one thing it must never do is fall back to the environment
 * silently, which is why callers get the null and make that choice themselves.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;

  const parts = stored.split(':');
  if (parts.length !== 3) return null;
  const [ivPart, tagPart, dataPart] = parts as [string, string, string];

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(ivPart, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
