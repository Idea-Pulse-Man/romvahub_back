/**
 * Read-only application Profiles shared with the signed-in User.
 * Distinct from `/api/profile` (legacy 1:1 stub) and `/api/admin/profiles`.
 */
import { Router } from 'express';
import { currentUserId, requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import {
  ProfileIdParamsSchema,
  type ProfileIdParams,
} from '../admin/profiles.schemas.js';
import * as profilesService from '../admin/profiles.service.js';

export const sharedProfilesRouter: Router = Router();

sharedProfilesRouter.use(requireAuth);

sharedProfilesRouter.get('/', async (req, res) => {
  res.json(await profilesService.listSharedWith(currentUserId(req)));
});

sharedProfilesRouter.get(
  '/:id',
  validate({ params: ProfileIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
    res.json(await profilesService.getSharedWith(currentUserId(req), id));
  },
);
