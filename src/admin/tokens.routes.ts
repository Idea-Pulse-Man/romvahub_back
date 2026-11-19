import { Router } from 'express';
import { z } from 'zod';
import { currentUserId, requireAdmin, requireAuth, requireSuperAdmin } from '../auth/require-auth.js';
import { newProfileToken } from '../auth/profile-tokens.js';
import { NotFoundError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { prisma } from '../prisma.js';

/**
 * Profile tokens, made and revoked by the Super Admin (the Tokens page).
 *
 *   GET    /api/admin/tokens       → every token: its Profile, label, when made and last used
 *   POST   /api/admin/tokens       { profileId, label?, expiresInDays } → the new token, shown this once
 *   DELETE /api/admin/tokens/:id   → revoked: it stops working at once
 *
 * The token goes into the Chrome extension's or the Resume agent's settings;
 * they then act as that Profile, with no sign-in, until it expires or is revoked.
 */

const CreateTokenSchema = z.object({
  profileId: z.uuid(),
  label: z.string().trim().max(100).default(''),
  /** How long it works: 7 days to a year. */
  expiresInDays: z.coerce.number().int().min(1).max(365).default(90),
});
const TokenIdParamsSchema = z.object({ id: z.uuid() });

type CreateTokenInput = z.infer<typeof CreateTokenSchema>;
type TokenIdParams = z.infer<typeof TokenIdParamsSchema>;

const tokenSelect = {
  id: true,
  label: true,
  prefix: true,
  createdAt: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  profile: { select: { id: true, firstName: true, lastName: true } },
  createdBy: { select: { email: true } },
} as const;

type TokenRow = {
  id: string;
  label: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  profile: { id: string; firstName: string; lastName: string };
  createdBy: { email: string } | null;
};

function toApi(row: TokenRow) {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    profile: {
      id: row.profile.id,
      name: [row.profile.firstName, row.profile.lastName].filter(Boolean).join(' ') || 'Profile',
    },
    createdBy: row.createdBy?.email ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export const adminTokensRouter: Router = Router();

adminTokensRouter.use(requireAuth, requireAdmin, requireSuperAdmin);

adminTokensRouter.get('/', async (_req, res) => {
  const rows = await prisma.profileToken.findMany({
    orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
    select: tokenSelect,
  });
  res.json(rows.map(toApi));
});

adminTokensRouter.post('/', validate({ body: CreateTokenSchema }), async (req, res) => {
  const { profileId, label, expiresInDays } = (req as ValidatedRequest<CreateTokenInput>).valid.body;
  const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { id: true } });
  if (!profile) throw new NotFoundError('No such Profile.');
  const { token, tokenHash, prefix } = newProfileToken();
  const row = await prisma.profileToken.create({
    data: {
      profileId,
      label,
      tokenHash,
      prefix,
      createdById: currentUserId(req),
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60_000),
    },
    select: tokenSelect,
  });
  res.status(201).json({ token, item: toApi(row) });
});

adminTokensRouter.delete('/:id', validate({ params: TokenIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, TokenIdParams>).valid.params;
  const { count } = await prisma.profileToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) {
    const exists = await prisma.profileToken.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundError('No such token.');
  }
  res.status(204).end();
});
