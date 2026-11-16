import {
  BidStatus as DbBidStatus,
  RateType as DbRateType,
  Theme as DbTheme,
} from '../generated/prisma/enums.js';
import type { BidStatus, RateType } from './types.js';

/**
 * Prisma enum members cannot contain spaces or parentheses, so the generated
 * TypeScript names are SCREAMING_CASE while the values actually stored in
 * Postgres (via `@map` in schema.prisma) are the exact strings the frontend
 * uses. This module is the only place that bridges the two.
 */

const STATUS_TO_DB = {
  Draft: DbBidStatus.DRAFT,
  Applied: DbBidStatus.APPLIED,
  'Screening (Round 1)': DbBidStatus.SCREENING_ROUND_1,
  'Interview (Round 2)': DbBidStatus.INTERVIEW_ROUND_2,
  'Interview (Round 3)': DbBidStatus.INTERVIEW_ROUND_3,
  'Final Interview': DbBidStatus.FINAL_INTERVIEW,
  Offer: DbBidStatus.OFFER,
  'Background Check Passed': DbBidStatus.BACKGROUND_CHECK_PASSED,
  Started: DbBidStatus.STARTED,
  Completed: DbBidStatus.COMPLETED,
  Failed: DbBidStatus.FAILED,
} as const satisfies Record<BidStatus, DbBidStatus>;

const STATUS_FROM_DB = Object.fromEntries(
  Object.entries(STATUS_TO_DB).map(([api, db]) => [db, api]),
) as Record<DbBidStatus, BidStatus>;

export function toDbStatus(status: BidStatus): DbBidStatus {
  return STATUS_TO_DB[status];
}

export function fromDbStatus(status: DbBidStatus): BidStatus {
  return STATUS_FROM_DB[status];
}

const RATE_TYPE_TO_DB = {
  hourly: DbRateType.HOURLY,
  annually: DbRateType.ANNUALLY,
} as const satisfies Record<RateType, DbRateType>;

export function toDbRateType(rateType: RateType): DbRateType {
  return RATE_TYPE_TO_DB[rateType];
}

export function fromDbRateType(rateType: DbRateType): RateType {
  return rateType === DbRateType.HOURLY ? 'hourly' : 'annually';
}

export function toDbTheme(theme: 'light' | 'dark'): DbTheme {
  return theme === 'light' ? DbTheme.LIGHT : DbTheme.DARK;
}

export function fromDbTheme(theme: DbTheme): 'light' | 'dark' {
  return theme === DbTheme.LIGHT ? 'light' : 'dark';
}

export { DbBidStatus, DbRateType, DbTheme };
