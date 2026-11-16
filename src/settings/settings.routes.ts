import { Router } from 'express';
import { currentUserId, currentUserRole, requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { AppSettingsSchema, type AppSettingsInput } from './settings.schemas.js';
import * as settingsService from './settings.service.js';

export const settingsRouter: Router = Router();

settingsRouter.use(requireAuth);

settingsRouter.get('/', async (req, res) => {
  res.json(await settingsService.getSettings(currentUserId(req)));
});

settingsRouter.put('/', validate({ body: AppSettingsSchema }), async (req, res) => {
  const body = (req as ValidatedRequest<AppSettingsInput>).valid.body;
  res.json(await settingsService.updateSettings(currentUserId(req), body, currentUserRole(req)));
});
