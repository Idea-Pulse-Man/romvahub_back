/**
 * Application Profiles shared with the signed-in User — read-only, except for
 * their Resume settings for "Make" (`/:id/prompts`, `/:id/template`): the
 * Resume prompt, cover letter prompt and Resume template, which the User may
 * edit and upload.
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
import * as avoidService from './profile-avoid.service.js';
import multer from 'multer';
import { BadRequestError } from '../http/errors.js';
import { contentDisposition } from '../http/content-disposition.js';

export const sharedProfilesRouter: Router = Router();

sharedProfilesRouter.use(requireAuth);

sharedProfilesRouter.get('/', async (req, res) => {
  res.json(await profilesService.listSharedWith(currentUserId(req)));
});

/**
 * A Profile's own Resume settings for "Make": Resume template and Resume
 * prompt (both required) and cover letter prompt (optional). Readable and
 * editable by an admin and by every User the Profile is shared with. See
 * `profile-prompts.service.ts`.
 */
sharedProfilesRouter.get('/:id/prompts', validate({ params: ProfileIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
  res.json(await promptsService.getProfileSettings(currentActor(req), id));
});

const promptField = z.string().max(promptsService.MAX_PROMPT_LENGTH, 'That prompt is too long.').nullable().optional();
const UpdateProfileSettingsSchema = z.object({
  resumePrompt: promptField,
  coverLetterPrompt: promptField,
  resumeTemplateId: z.string().trim().min(1).max(200).optional(),
});
type UpdateProfileSettingsInput = z.infer<typeof UpdateProfileSettingsSchema>;

sharedProfilesRouter.put(
  '/:id/prompts',
  validate({ params: ProfileIdParamsSchema, body: UpdateProfileSettingsSchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<UpdateProfileSettingsInput, ProfileIdParams>;
    res.json(await promptsService.updateProfileSettings(currentActor(req), valid.params.id, valid.body));
  },
);

/**
 * A Profile's "Avoid" lists — roles and companies the scraper extension does
 * not save for it. Same access as the prompts. See `profile-avoid.service.ts`.
 */
sharedProfilesRouter.get('/:id/avoid', validate({ params: ProfileIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
  res.setHeader('Cache-Control', 'no-store');
  res.json(await avoidService.getAvoidLists(currentActor(req), id));
});

const avoidList = z
  .array(z.string().max(avoidService.MAX_AVOID_ENTRY_LENGTH, 'An entry is too long (100 characters at most).'))
  .max(avoidService.MAX_AVOID_ENTRIES, 'Too many entries (300 at most).')
  .optional();
const UpdateAvoidListsSchema = z.object({ avoidRoles: avoidList, avoidCompanies: avoidList });
type UpdateAvoidListsInput = z.infer<typeof UpdateAvoidListsSchema>;

sharedProfilesRouter.put(
  '/:id/avoid',
  validate({ params: ProfileIdParamsSchema, body: UpdateAvoidListsSchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<UpdateAvoidListsInput, ProfileIdParams>;
    res.json(await avoidService.updateAvoidLists(currentActor(req), valid.params.id, valid.body));
  },
);

/** A new Resume template (.docx, the `template` field) for this Profile, made its template. */
const templateUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

sharedProfilesRouter.post(
  '/:id/template',
  validate({ params: ProfileIdParamsSchema }),
  templateUpload.single('template'),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
    if (!req.file?.buffer?.length) throw new BadRequestError('No template was uploaded. Send a .docx as the `template` field.');
    res.json(
      await promptsService.uploadProfileTemplate(currentActor(req), id, {
        // multer reads the name as latin1; browsers send UTF-8.
        originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
        bytes: req.file.buffer,
      }),
    );
  },
);

/** The Profile's current Resume template, to download, edit in Word and upload again. */
sharedProfilesRouter.get('/:id/template', validate({ params: ProfileIdParamsSchema }), async (req, res) => {
  const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
  const { name, bytes } = await promptsService.profileTemplateFile(currentActor(req), id);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', contentDisposition('attachment', name));
  res.send(bytes);
});

sharedProfilesRouter.get(
  '/:id',
  validate({ params: ProfileIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, ProfileIdParams>).valid.params;
    res.json(await profilesService.getSharedWith(currentUserId(req), id));
  },
);
