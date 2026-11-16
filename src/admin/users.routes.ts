import { Router } from 'express';
import multer from 'multer';
import { currentUserId, requireAdmin, requireAuth } from '../auth/require-auth.js';
import { BadRequestError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { ProfileSchema, type ProfileInput } from '../profile/profile.schemas.js';
import * as profileService from '../profile/profile.service.js';
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from '../storage/s3.client.js';
import {
  CreateUserSchema,
  SetUserSharedProfilesSchema,
  UpdateUserSchema,
  UserIdParamsSchema,
  type CreateUserInput,
  type SetUserSharedProfilesInput,
  type UpdateUserInput,
  type UserIdParams,
} from './users.schemas.js';
import * as usersService from './users.service.js';
import * as profilesService from './profiles.service.js';
import {
  UserAiPromptsSchema,
  type UserAiPromptsInput,
} from '../ai-config/user-prompts.schemas.js';
import * as userPromptsService from '../ai-config/user-prompts.service.js';

export const adminUsersRouter: Router = Router();

adminUsersRouter.use(requireAuth, requireAdmin);

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
});

adminUsersRouter.get('/', async (_req, res) => {
  res.json(await usersService.listUsers());
});

adminUsersRouter.post('/', validate({ body: CreateUserSchema }), async (req, res) => {
  const body = (req as ValidatedRequest<CreateUserInput>).valid.body;
  res.status(201).json(await usersService.createUser(body));
});

adminUsersRouter.get('/:id', validate({ params: UserIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, UserIdParams>).valid.params;
  res.json(await usersService.getUser(id));
});

adminUsersRouter.get(
  '/:id/login-history',
  validate({ params: UserIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, UserIdParams>).valid.params;
    res.json(await usersService.listLoginHistory(id));
  },
);

/** The account itself: sign-in address, password, role. */
adminUsersRouter.patch(
  '/:id',
  validate({ params: UserIdParamsSchema, body: UpdateUserSchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<UpdateUserInput, UserIdParams>;
    res.json(await usersService.updateUser(currentUserId(req), valid.params.id, valid.body));
  },
);

adminUsersRouter.delete('/:id', validate({ params: UserIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, UserIdParams>).valid.params;
  await usersService.deleteUser(currentUserId(req), id);
  res.status(204).end();
});

/**
 * Which application Profiles this User may use. Full replace — the Users
 * page's share dialog is the inverse of sharing Users from a Profile card.
 */
adminUsersRouter.get(
  '/:id/shared-profiles',
  validate({ params: UserIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, UserIdParams>).valid.params;
    await usersService.getUser(id); // 404 if the account does not exist
    res.json(await profilesService.listSharedWith(id));
  },
);

adminUsersRouter.put(
  '/:id/shared-profiles',
  validate({ params: UserIdParamsSchema, body: SetUserSharedProfilesSchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<SetUserSharedProfilesInput, UserIdParams>;
    res.json(await profilesService.setUserSharedProfiles(valid.params.id, valid.body.profileIds));
  },
);

/**
 * The Resume profile of another account.
 *
 * Straight through to the same service the owner's own `/api/profile` uses, so
 * there is one set of rules about how work history and education are rewritten
 * — an admin editing a profile and its owner editing it are the same write.
 */
adminUsersRouter.put(
  '/:id/profile',
  validate({ params: UserIdParamsSchema, body: ProfileSchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<ProfileInput, UserIdParams>;
    res.json(await profileService.updateProfile(valid.params.id, valid.body));
  },
);

adminUsersRouter.post(
  '/:id/profile/photo',
  validate({ params: UserIdParamsSchema }),
  photoUpload.single('photo'),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, UserIdParams>).valid.params;
    const file = req.file;
    if (!file) throw new BadRequestError('No photo was uploaded. Send one as the `photo` field.');

    if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new BadRequestError(
        `That file is a ${file.mimetype}. Photos must be one of: ${PHOTO_CONTENT_TYPES.join(', ')}.`,
      );
    }

    res.json(await profileService.replacePhoto(id, file.buffer, file.mimetype));
  },
);

/**
 * One account's AI prompts — the per-profile half of AI settings. Admin-only
 * like the deployment's: there is no self-service route, and a candidate does
 * not see their own.
 */
adminUsersRouter.get(
  '/:id/ai-prompts',
  validate({ params: UserIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, UserIdParams>).valid.params;
    res.json(await userPromptsService.getUserPrompts(id));
  },
);

adminUsersRouter.put(
  '/:id/ai-prompts',
  validate({ params: UserIdParamsSchema, body: UserAiPromptsSchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<UserAiPromptsInput, UserIdParams>;
    res.json(await userPromptsService.updateUserPrompts(valid.params.id, valid.body));
  },
);

adminUsersRouter.delete(
  '/:id/profile/photo',
  validate({ params: UserIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, UserIdParams>).valid.params;
    res.json(await profileService.removePhoto(id));
  },
);
