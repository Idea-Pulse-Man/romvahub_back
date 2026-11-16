import { Router } from 'express';
import { currentUserId, currentUserRole, requireAuth } from '../auth/require-auth.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import {
  ImportBundleSchema,
  ImportQuerySchema,
  type ImportBundle,
  type ImportQuery,
} from './data.schemas.js';
import * as dataService from './data.service.js';

export const dataRouter: Router = Router();

dataRouter.use(requireAuth);

dataRouter.get('/export', async (req, res) => {
  const bundle = await dataService.exportData(currentUserId(req));

  // Named so a browser hitting this URL saves the same filename the frontend's
  // client-side export already produces.
  res.setHeader('Content-Disposition', 'attachment; filename="remote-ops-backup.json"');
  res.json(bundle);
});

dataRouter.post(
  '/import',
  validate({ body: ImportBundleSchema, query: ImportQuerySchema }),
  async (req, res) => {
    const { valid } = req as ValidatedRequest<ImportBundle, unknown, ImportQuery>;
    res.json(
      await dataService.importData(
        currentUserId(req),
        valid.body,
        valid.query,
        currentUserRole(req),
      ),
    );
  },
);

dataRouter.delete('/', async (req, res) => {
  res.json(await dataService.resetData(currentUserId(req)));
});
