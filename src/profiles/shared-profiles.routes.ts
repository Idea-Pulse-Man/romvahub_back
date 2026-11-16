/**
 * Application Profiles shared with the signed-in User — read-only, except for
 * their ChatGPT prompts (`/:id/prompts`), which the User may edit.
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
import { z } from 'zod';
import { currentActor } from '../auth/actor.js';
import * as promptsService from './profile-prompts.service.js';

export const sharedProfilesRouter: Router = Router();

sharedProfilesRouter.use(requireAuth);

sharedProfilesRouter.get('/', async (req, res) => {
  res.json(await profilesService.listSharedWith(currentUserId(req)));
});

/**
 * A Profile's own ChatGPT prompts for "Make" (Resume, cover letter), with the
 * defaults used while it has none. Readable and editable by an admin and by
 * every User the Profile is shared with. See `profile-prompts.service.ts`.
 */
sharedProfilesRouter.get('/:id/prompts', validate({ params: ProfileIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
  res.json(await promptsService.getProfilePrompts(currentActor(req), id));
});

const promptField = z.string().max(promptsService.MAX_PROMPT_LENGTH, 'That prompt is too long.').nullable().optional();
const UpdateProfilePromptsSchema = z.object({ resumePrompt: promptField, coverLetterPrompt: promptField });
type UpdateProfilePromptsInput = z.infer<typeof UpdateProfilePromptsSchema>;

sharedProfilesRouter.put(
  '/:id/prompts',
  validate({ params: ProfileIdParamsSchema, body: UpdateProfilePromptsSchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<UpdateProfilePromptsInput, ProfileIdParams>;
    res.json(await promptsService.updateProfilePrompts(currentActor(req), valid.params.id, valid.body));
  },
);

sharedProfilesRouter.get(
  '/:id',
  validate({ params: ProfileIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
    res.json(await profilesService.getSharedWith(currentUserId(req), id));
  },
);
