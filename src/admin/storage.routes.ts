import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { currentActor } from '../auth/actor.js';
import { requireAuth, requireSuperAdmin } from '../auth/require-auth.js';
import { contentDisposition } from '../http/content-disposition.js';
import { BadRequestError } from '../http/errors.js';
import { validate, type ValidatedRequest } from '../http/validate.js';
import { RangeSchema, type RangeInput } from '../resume/store/range.js';
import { makeBackup, removeBackedUp, restoreBackup, storageSummary } from './storage.service.js';

/**
 * The Storage page, Super Admin only (`/api/admin/storage`):
 *
 *   GET  /                       database size and limit, biggest tables, the Resume folder, recent backups
 *   POST /backup                 { from, to, statuses, profileId? } → the backup .zip (X-Backup-Id); removes nothing
 *   POST /backups/:id/remove     after the Super Admin confirms: removes what that backup saved, then compacts
 *   POST /restore?dryRun=true    multipart `backup` (.zip): puts it back (dryRun: only counts)
 */

export const storageRouter: Router = Router();
storageRouter.use(requireAuth, requireSuperAdmin);

storageRouter.get('/', async (_req, res) => {
  res.json(await storageSummary());
});

storageRouter.post('/backup', validate({ body: RangeSchema }), async (req, res) => {
  const range = (req as ValidatedRequest<RangeInput>).valid.body;
  const backup = await makeBackup(currentActor(req), range);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', backup.zip.byteLength);
  res.setHeader('Content-Disposition', contentDisposition('attachment', backup.fileName));
  res.setHeader('X-Backup-Id', backup.id);
  res.setHeader('X-Backup-Count', String(backup.count));
  res.setHeader('Access-Control-Expose-Headers', 'X-Backup-Id, X-Backup-Count, Content-Disposition');
  res.send(backup.zip);
});

storageRouter.post(
  '/backups/:id/remove',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  async (req, res) => {
    const { id } = (req as ValidatedRequest<unknown, { id: string }>).valid.params;
    res.json(await removeBackedUp(currentActor(req), id));
  },
);

/** A backup of a few thousand applications with old Resume files can be a few hundred MB. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024, files: 1 } });

storageRouter.post('/restore', upload.single('backup'), async (req, res) => {
  const file = (req as typeof req & { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('Choose the backup .zip file to restore.');
  const dryRun = String(req.query.dryRun ?? '') === 'true';
  res.json(await restoreBackup(currentActor(req), file.buffer, { dryRun }));
});
