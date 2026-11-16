import { prisma } from '../prisma.js';
import {
  formatDateOnly,
  formatNaiveDateTime,
  naiveNow,
  startOfDayUtc,
} from '../domain/dates.js';
import { fromDbRateType, fromDbStatus, toDbStatus } from '../domain/status.js';
import { BID_STATUSES, type BidStatus } from '../domain/types.js';
import type { DashboardQuery } from './dashboard.schemas.js';

export interface DayCount {
  date: string;
  count: number;
}

export interface UpcomingInterview {
  bidId: string;
  company: string;
  role: string;
  stage: BidStatus;
  dateTime: string;
}

export interface StartedContract {
  bidId: string;
  company: string;
  role: string;
  rate: number | null;
  rateType: 'hourly' | 'annually' | null;
  startedOn: string;
}

export interface DashboardSummary {
  totalApplications: number;
  /** Every status, including the zeroes — the pie chart's legend is fixed. */
  statusBreakdown: { status: BidStatus; count: number }[];
  dailyGoal: number;
  todayCount: number;
  dailyVolume: DayCount[];
  activity: { from: string; to: string; days: DayCount[] };
  upcomingInterviews: UpcomingInterview[];
  startedContracts: StartedContract[];
}

/** Every date from `start` to `end` inclusive, filled from `counts` or zero. */
function fillRange(start: Date, end: Date, counts: Map<string, number>): DayCount[] {
  const days: DayCount[] = [];
  for (let day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = formatDateOnly(day);
    days.push({ date, count: counts.get(date) ?? 0 });
  }
  return days;
}

export async function getDashboard(
  userId: string,
  query: DashboardQuery,
): Promise<DashboardSummary> {
  const now = naiveNow(query.tzOffset);
  const today = startOfDayUtc(now);
  const volumeStart = startOfDayUtc(now, query.days - 1);
  const activityStart = startOfDayUtc(now, query.weeks * 7 - 1);

  const [total, byStatus, byDate, settings, interviews, started] = await Promise.all([
    prisma.bid.count({ where: { userId } }),

    prisma.bid.groupBy({
      by: ['status'],
      where: { userId },
      _count: { _all: true },
    }),

    // One grouped scan covers both the 7-day line chart and the 12-week
    // heatmap; the wider range is a superset of the narrower one.
    prisma.bid.groupBy({
      by: ['bidDate'],
      where: { userId, bidDate: { gte: activityStart, lte: today } },
      _count: { _all: true },
    }),

    prisma.settings.findUnique({ where: { userId }, select: { dailyBidGoal: true } }),

    prisma.interviewRound.findMany({
      where: { bid: { userId }, dateTime: { gte: now } },
      orderBy: { dateTime: 'asc' },
      take: query.limit,
      select: {
        stage: true,
        dateTime: true,
        bid: { select: { id: true, company: true, role: true } },
      },
    }),

    // Not `take`n in SQL: the sort key is "commitment start date, falling back
    // to updatedAt", which spans a relation. Active engagements are a handful
    // of rows, so ordering them in memory is cheaper than the query it would
    // take to express that in SQL.
    prisma.bid.findMany({
      where: { userId, status: toDbStatus('Started') },
      select: {
        id: true,
        company: true,
        role: true,
        rateType: true,
        rateAmount: true,
        updatedAt: true,
        commitment: { select: { startDate: true, agreedRate: true } },
      },
    }),
  ]);

  const statusCounts = new Map<BidStatus, number>(
    byStatus.map((group) => [fromDbStatus(group.status), group._count._all]),
  );

  const dateCounts = new Map<string, number>(
    byDate.map((group) => [formatDateOnly(group.bidDate), group._count._all]),
  );

  const todayKey = formatDateOnly(today);

  return {
    totalApplications: total,
    statusBreakdown: BID_STATUSES.map((status) => ({
      status,
      count: statusCounts.get(status) ?? 0,
    })),
    dailyGoal: settings?.dailyBidGoal ?? 100,
    todayCount: dateCounts.get(todayKey) ?? 0,
    dailyVolume: fillRange(volumeStart, today, dateCounts),
    activity: {
      from: formatDateOnly(activityStart),
      to: todayKey,
      days: fillRange(activityStart, today, dateCounts),
    },
    upcomingInterviews: interviews.map((round) => ({
      bidId: round.bid.id,
      company: round.bid.company,
      role: round.bid.role,
      stage: fromDbStatus(round.stage),
      dateTime: formatNaiveDateTime(round.dateTime),
    })),
    startedContracts: started
      .map((bid) => ({
        bidId: bid.id,
        company: bid.company,
        role: bid.role,
        // Business rule 4: the agreed rate overrides the rate originally bid.
        rate:
          bid.commitment?.agreedRate != null
            ? Number(bid.commitment.agreedRate)
            : bid.rateAmount != null
              ? Number(bid.rateAmount)
              : null,
        rateType: bid.rateType === null ? null : fromDbRateType(bid.rateType),
        startedOn: formatDateOnly(bid.commitment?.startDate ?? bid.updatedAt),
      }))
      .sort((a, b) => b.startedOn.localeCompare(a.startedOn))
      .slice(0, query.limit),
  };
}
