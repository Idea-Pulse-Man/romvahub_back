import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { UnauthorizedError } from '../http/errors.js';
import type { UserRole } from './auth.schemas.js';
import { parseDuration } from './cookies.js';

const ISSUER = 'remote-ops-backend';
const AUDIENCE = 'remote-ops-app';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
}

/**
 * Signs an access token that lives `ACCESS_TOKEN_TTL`, but never past
 * `sessionExpiresAt` — so the last token of a session ends with the session
 * rather than up to one TTL after it.
 */
export function signAccessToken(payload: AccessTokenPayload, sessionExpiresAt?: Date): string {
  let ttlSeconds = Math.floor(parseDuration(env.ACCESS_TOKEN_TTL) / 1000);
  if (sessionExpiresAt) {
    const remaining = Math.floor((sessionExpiresAt.getTime() - Date.now()) / 1000);
    ttlSeconds = Math.max(1, Math.min(ttlSeconds, remaining));
  }
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: ttlSeconds,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
      throw new UnauthorizedError('Malformed access token.');
    }
    // A token minted before roles existed carries none. Reading that as `user`
    // rather than rejecting it keeps sessions alive across the deploy, and the
    // safe default is the one with fewer screens.
    const role = (decoded as jwt.JwtPayload).role;
    return {
      sub: decoded.sub,
      email: String((decoded as jwt.JwtPayload).email ?? ''),
      role: role === 'admin' ? 'admin' : 'user',
    };
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Access token expired.');
    }
    throw new UnauthorizedError('Invalid access token.');
  }
}

/**
 * Refresh tokens are opaque random strings, not JWTs — they are looked up in
 * the database on every use so they can be revoked, which a self-contained
 * token cannot be. Only the SHA-256 digest is stored, so a database leak does
 * not hand over usable tokens.
 *
 * `expiresAt` is passed on rotation so the replacement keeps the session's
 * original deadline: a session lasts `REFRESH_TOKEN_TTL_DAYS` from sign-in,
 * however active it is, rather than sliding forward on every refresh.
 */
export function createRefreshToken(
  expiresAt: Date = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(48).toString('base64url');
  return { token, tokenHash: hashRefreshToken(token), expiresAt };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
