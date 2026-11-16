import { Router } from 'express';
import { currentUserId, requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { DashboardQuerySchema, type DashboardQuery } from './dashboard.schemas.js';
import * as dashboardService from './dashboard.service.js';

export const dashboardRouter: Router = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get('/', validate({ query: DashboardQuerySchema }), async (req, res) => {
  const query = (req as ValidatedRequest<unknown, unknown, DashboardQuery>).valid.query;
  res.json(await dashboardService.getDashboard(currentUserId(req), query));
});
