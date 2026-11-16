import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id at the OWASP-recommended second configuration (19 MiB, t=2, p=1).
 * `@node-rs/argon2` ships prebuilt platform binaries, so there is no native
 * compile step on install.
 */
const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

export async function verifyPassword(digest: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(digest, plaintext, OPTIONS);
  } catch {
    // A malformed digest is a failed verification, not a 500.
    return false;
  }
}
