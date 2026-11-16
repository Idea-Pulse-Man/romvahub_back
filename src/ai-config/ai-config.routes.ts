import { Router } from 'express';
import { requireAdmin, requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { AiSettingsSchema, type AiSettingsInput } from './ai-config.schemas.js';
import * as aiConfigService from './ai-config.service.js';

export const aiConfigRouter: Router = Router();

// Admin-only in full: the system prompt is the product, and the key is a
// credential. Neither is something a plain account has any reason to read.
aiConfigRouter.use(requireAuth, requireAdmin);

aiConfigRouter.get('/', async (_req, res) => {
  res.json(await aiConfigService.getSettings());
});

aiConfigRouter.put('/', validate({ body: AiSettingsSchema }), async (req, res) => {
  const body = (req as ValidatedRequest<AiSettingsInput>).valid.body;
  res.json(await aiConfigService.updateSettings(body));
});
