import { Router } from 'express';
import { currentActor } from '../auth/actor.js';
import { currentUserId, requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import {
  CreateNotificationSchema,
  NotificationIdParamsSchema,
  type CreateNotificationInput,
  type NotificationIdParams,
} from './notifications.schemas.js';
import * as notificationsService from './notifications.service.js';

export const notificationsRouter: Router = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get('/', async (req, res) => {
  res.json(await notificationsService.list(currentUserId(req)));
});

notificationsRouter.post(
  '/',
  validate({ body: CreateNotificationSchema }),
  async (req, res) => {
    const input = (req as ValidatedRequest<CreateNotificationInput>).valid.body;
    res.status(201).json(await notificationsService.create(currentActor(req), input));
  },
);

// Static route must precede `/:id/read`.
notificationsRouter.post('/read-all', async (req, res) => {
  res.json(await notificationsService.markAllRead(currentUserId(req)));
});

notificationsRouter.post(
  '/:id/read',
  validate({ params: NotificationIdParamsSchema }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, NotificationIdParams>).valid.params;
    await notificationsService.markRead(currentUserId(req), id);
    res.status(204).send();
  },
);
