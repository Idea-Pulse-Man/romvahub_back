import { z } from 'zod';

export const DashboardQuerySchema = z.object({
  /** Length of the "Weekly Bid Volume" line chart. */
  days: z.coerce.number().int().min(1).max(366).default(7),
  /** Length of the activity heatmap. */
  weeks: z.coerce.number().int().min(1).max(53).default(12),
  /** How many rows the "Upcoming Schedules" and "Started Contracts" cards show. */
  limit: z.coerce.number().int().min(1).max(50).default(5),
  /**
   * The client's `Date.prototype.getTimezoneOffset()` — minutes behind UTC,
   * positive west of it. Without this the server would compute "today" and
   * "upcoming" in UTC and disagree with the browser near midnight.
   */
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
});

export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;
