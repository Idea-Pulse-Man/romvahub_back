import { z } from 'zod';
import { CreateBidSchema } from '../bids/bids.schemas.js';
import { ProfileSchema } from '../profile/profile.schemas.js';
import { AppSettingsSchema } from '../settings/settings.schemas.js';

/**
 * The shape `Preferences.tsx` already writes to `remote-ops-backup.json`. Accepting
 * exactly it closes the gap the README calls out: the frontend could export a
 * backup but had no way to restore one.
 *
 * `id`, `createdAt` and `updatedAt` in an exported bid are ignored on import —
 * restored bids are new rows owned by whoever is importing them.
 */
export const ImportBundleSchema = z.object({
  bids: z.array(CreateBidSchema).max(10_000).default([]),
  profile: ProfileSchema.optional(),
  settings: AppSettingsSchema.optional(),
});

export const ImportQuerySchema = z.object({
  /**
   * `merge` (default) adds the imported bids alongside what is already there.
   * `replace` deletes the account's existing bids first.
   */
  mode: z.enum(['merge', 'replace']).default('merge'),
});

export type ImportBundle = z.infer<typeof ImportBundleSchema>;
export type ImportQuery = z.infer<typeof ImportQuerySchema>;
