import { z } from 'zod';
import { BidStatusSchema } from '../../bids/bids.schemas.js';
import { parseDateOnly } from '../../domain/dates.js';
import { toDbStatus } from '../../domain/status.js';
import type { Prisma as PrismaTypes } from '../../generated/prisma/client.js';

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/** The choices shared by "Make files" and the Storage page's backup: a date range, statuses, a Profile. */
export const RangeSchema = z
  .object({
    from: DateSchema,
    to: DateSchema,
    statuses: z.array(BidStatusSchema).min(1, 'Choose at least one status.'),
    profileId: z.string().uuid().optional(),
  })
  .refine((value) => value.from <= value.to, { message: '"From" must not be after "To".', path: ['from'] });
export type RangeInput = z.infer<typeof RangeSchema>;

/** The applications a range names, by the application's date (the Applications list's Date column). */
export function rangeWhere(range: RangeInput): PrismaTypes.BidWhereInput {
  return {
    bidDate: { gte: parseDateOnly(range.from), lte: parseDateOnly(range.to) },
    status: { in: range.statuses.map(toDbStatus) },
    ...(range.profileId ? { profileId: range.profileId } : {}),
  };
}
