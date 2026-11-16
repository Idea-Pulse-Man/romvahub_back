import { Router } from 'express';
import multer from 'multer';
import { requireAdmin, requireAuth } from '../auth/require-auth.js';
import { BadRequestError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from '../storage/s3.client.js';
import * as profileService from '../profile/profile.service.js';
import {
  CreateProfileSchema,
  ProfileIdParamsSchema,
  SetProfileSharesSchema,
  type CreateProfileInput,
  type ProfileIdParams,
  type SetProfileSharesInput,
} from './profiles.schemas.js';
import * as profilesService from './profiles.service.js';

export const adminProfilesRouter: Router = Router();

adminProfilesRouter.use(requireAuth, requireAdmin);

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
});

adminProfilesRouter.get('/', async (_req, res) => {
  res.json(await profilesService.listProfiles());
});

adminProfilesRouter.post('/', validate({ body: CreateProfileSchema }), async (req, res) => {
  const body = (req as ValidatedRequest<CreateProfileInput>).valid.body;
  res.status(201).json(await profilesService.createProfile(body));
});

adminProfilesRouter.get(
  '/:id',
  validate({ params: ProfileIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
    res.json(await profilesService.getProfile(id));
  },
);

adminProfilesRouter.put(
  '/:id',
  validate({ params: ProfileIdParamsSchema, body: CreateProfileSchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<CreateProfileInput, ProfileIdParams>;
    res.json(await profilesService.updateProfile(valid.params.id, valid.body));
  },
);

adminProfilesRouter.put(
  '/:id/shares',
  validate({ params: ProfileIdParamsSchema, body: SetProfileSharesSchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<SetProfileSharesInput, ProfileIdParams>;
    res.json(await profilesService.setProfileShares(valid.params.id, valid.body));
  },
);

adminProfilesRouter.delete(
  '/:id',
  validate({ params: ProfileIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
    await profilesService.deleteProfile(id);
    res.status(204).end();
  },
);

adminProfilesRouter.post(
  '/:id/photo',
  validate({ params: ProfileIdParamsSchema }),
  photoUpload.single('photo'),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
    const file = req.file;
    if (!file) throw new BadRequestError('No photo was uploaded. Send one as the `photo` field.');

    if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new BadRequestError(
        `That file is a ${file.mimetype}. Photos must be one of: ${PHOTO_CONTENT_TYPES.join(', ')}.`,
      );
    }

    res.json(await profileService.replacePhotoById(id, file.buffer, file.mimetype));
  },
);

adminProfilesRouter.delete(
  '/:id/photo',
  validate({ params: ProfileIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
    res.json(await profileService.removePhotoById(id));
  },
);
