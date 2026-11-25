import { Router } from 'express';
import { readStoredFile, verifyFileSignature } from './s3.client.js';

/**
 * Stored photos and proof screenshots, by signed link (see `signPhotoUrl`):
 *
 *   GET /api/files/<key>?e=<expires>&s=<signature>
 *
 * No sign-in: the signature is the permission, so a plain `<img src>` works.
 * The link stops working when it expires.
 */
export const filesRouter: Router = Router();

filesRouter.get('/*key', async (req, res) => {
  const parts = (req.params as { key?: string[] | string }).key;
  const key = Array.isArray(parts) ? parts.join('/') : String(parts ?? '');
  const expires = Number(req.query.e);
  const signature = typeof req.query.s === 'string' ? req.query.s : '';
  if (!key || !verifyFileSignature(key, expires, signature)) {
    res.status(403).json({ error: 'This file link is not valid or has expired.' });
    return;
  }
  const file = await readStoredFile(key);
  if (!file) {
    res.status(404).json({ error: 'No such file.' });
    return;
  }
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Length', String(file.bytes.length));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.bytes);
});
