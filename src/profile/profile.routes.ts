import { Router } from 'express';
import multer from 'multer';
import { currentUserId, requireAuth } from '../auth/require-auth.js';
import { BadRequestError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from '../storage/s3.client.js';
import { ProfileSchema, type ProfileInput } from './profile.schemas.js';
import * as profileService from './profile.service.js';

export const profileRouter: Router = Router();

profileRouter.use(requireAuth);

/**
 * The photo is held in memory rather than spooled to disk: it is capped at 5 MB
 * and is on its way straight to the bucket, so a temp file would only be a file
 * to clean up. `limits` is what stops a larger body being read at all — the
 * check happens as the stream arrives, not after it has been buffered.
 */
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
});

profileRouter.get('/', async (req, res) => {
  res.json(await profileService.getProfile(currentUserId(req)));
});

profileRouter.put('/', validate({ body: ProfileSchema }), async (req, res) => {
  const body = (req as ValidatedRequest<ProfileInput>).valid.body;
  res.json(await profileService.updateProfile(currentUserId(req), body));
});

/**
 * Its own route rather than a field on `PUT /api/profile`, because the two are
 * different requests: the form is JSON the user edits and re-saves, the photo
 * is multipart and is replaced by picking a file. Folding one into the other
 * would mean re-uploading the image on every unrelated save.
 */
profileRouter.post('/photo', photoUpload.single('photo'), async (req, res) => {
  const file = req.file;
  if (!file) throw new BadRequestError('No photo was uploaded. Send one as the `photo` field.');

  if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(file.mimetype)) {
    throw new BadRequestError(
      `That file is a ${file.mimetype}. Photos must be one of: ${PHOTO_CONTENT_TYPES.join(', ')}.`,
    );
  }

  res.json(await profileService.replacePhoto(currentUserId(req), file.buffer, file.mimetype));
});

profileRouter.delete('/photo', async (req, res) => {
  res.json(await profileService.removePhoto(currentUserId(req)));
});
