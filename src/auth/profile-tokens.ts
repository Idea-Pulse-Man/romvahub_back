import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import { prisma } from '../prisma.js';

/**
 * Profile tokens: how the Chrome extension and the Resume agent sign in.
 *
 * The Super Admin makes one per Profile (Tokens page). It is sent as
 * `Authorization: Bearer rmv_…` and acts as that Profile only: the requests
 * it makes see that Profile's applications and no others, and it may call only
 * the routes the extension and the agent use (`TOKEN_ROUTES`). It never
 * expires; it works until revoked. Only its SHA-256 digest is stored.
 */

export const PROFILE_TOKEN_PREFIX = 'rmv_';

/** How often a token's "last used" time is written (not on every request). */
const TOUCH_EVERY_MS = 5 * 60_000;

export function isProfileToken(token: string): boolean {
  return token.startsWith(PROFILE_TOKEN_PREFIX);
}

export function hashProfileToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newProfileToken(): { token: string; tokenHash: string; prefix: string } {
  const token = `${PROFILE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashProfileToken(token), prefix: token.slice(0, 10) };
}

export interface ProfileTokenIdentity {
  /** The account the Profile's applications are filed under (for its prompts and settings). */
  userId: string;
  email: string;
  profileId: string;
  tokenId: string;
}

/** The token's Profile and account; 401 when it is unknown or revoked. */
export async function resolveProfileToken(token: string): Promise<ProfileTokenIdentity> {
  const row = await prisma.profileToken.findUnique({
    where: { tokenHash: hashProfileToken(token) },
    select: {
      id: true,
      revokedAt: true,
      lastUsedAt: true,
      createdById: true,
      profile: {
        select: {
          id: true,
          userId: true,
          email: true,
          shares: { select: { userId: true }, orderBy: { createdAt: 'asc' }, take: 1 },
        },
      },
    },
  });
  if (!row || row.revokedAt) {
    throw new UnauthorizedError('This Romva token was revoked or does not exist. Ask the Super Admin for a new one.');
  }
  const userId = row.profile.userId ?? row.profile.shares[0]?.userId ?? row.createdById;
  if (!userId) throw new UnauthorizedError('This Romva token’s Profile has no account. Ask the Super Admin.');

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    void prisma.profileToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
  return { userId, email: row.profile.email ?? '', profileId: row.profile.id, tokenId: row.id };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The only routes a Profile token may call: what the extension and the agent need. */
const TOKEN_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/api\/auth\/me$/ },
  // The extension: the jobs to fill, what to fill in, and marking one Applied.
  { method: 'GET', path: new RegExp(`^/api/auto-make/apply/(next|all|${UUID})$`, 'i') },
  { method: 'GET', path: new RegExp(`^/api/bids/${UUID}$`, 'i') },
  { method: 'POST', path: /^\/api\/bids\/bulk\/status$/ },
  // The Resume agent: the make queue.
  { method: 'POST', path: /^\/api\/auto-make\/(claim|heartbeat|release-held)$/ },
  { method: 'POST', path: new RegExp(`^/api/auto-make/jobs/${UUID}/(check-resume|resume|cover-letter|release)$`, 'i') },
];

/** 403 unless a Profile token may make this request. */
export function assertTokenRoute(req: Request): void {
  const path = req.originalUrl.split('?')[0]?.replace(/\/+$/, '') ?? '';
  const allowed = TOKEN_ROUTES.some((route) => route.method === req.method && route.path.test(path));
  if (!allowed) throw new ForbiddenError('A Romva token may only be used by the extension and the agent.');
  // The extension marks an application Applied, and nothing else.
  if (path === '/api/bids/bulk/status' && (req.body as { status?: unknown } | undefined)?.status !== 'Applied') {
    throw new ForbiddenError('A Romva token may only mark applications Applied.');
  }
}

/** For `GET /api/auth/me` with a token: which Profile it acts as. */
export async function describeToken(tokenId: string): Promise<{ id: string; label: string; profile: { id: string; name: string } }> {
  const row = await prisma.profileToken.findUnique({
    where: { id: tokenId },
    select: { id: true, label: true, profile: { select: { id: true, firstName: true, lastName: true } } },
  });
  if (!row) throw new UnauthorizedError('This Romva token was revoked or does not exist.');
  const name = [row.profile.firstName, row.profile.lastName].filter(Boolean).join(' ') || 'Profile';
  return { id: row.id, label: row.label, profile: { id: row.profile.id, name } };
}
