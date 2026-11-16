import { prisma } from '../prisma.js';
import type { UserRole } from '../auth/auth.schemas.js';
import { fromDbTheme, toDbTheme } from '../domain/status.js';
import type { AppSettings } from '../domain/types.js';
import type { AppSettingsInput } from './settings.schemas.js';

const DEFAULTS: AppSettings = { dailyBidGoal: 100, theme: 'light' };

export async function getSettings(userId: string): Promise<AppSettings> {
  const row = await prisma.settings.findUnique({ where: { userId } });
  if (!row) return { ...DEFAULTS };

  return { dailyBidGoal: row.dailyBidGoal, theme: fromDbTheme(row.theme) };
}

/**
 * `dailyBidGoal` is an administrator's setting; `theme` is the account's own.
 *
 * A non-admin's save keeps whatever goal is stored, whatever it sends. The
 * alternative — rejecting the whole request — would break the theme toggle,
 * which submits the entire settings object and has no business failing over a
 * field it never touched. The saved value comes back in the response, so a
 * client that tried anyway sees immediately that it did not take.
 */
export async function updateSettings(
  userId: string,
  input: AppSettingsInput,
  role: UserRole,
): Promise<AppSettings> {
  const theme = toDbTheme(input.theme);

  const existing = await prisma.settings.findUnique({
    where: { userId },
    select: { dailyBidGoal: true },
  });

  const dailyBidGoal =
    role === 'admin' ? input.dailyBidGoal : (existing?.dailyBidGoal ?? DEFAULTS.dailyBidGoal);

  const row = await prisma.settings.upsert({
    where: { userId },
    create: { userId, dailyBidGoal, theme },
    update: { dailyBidGoal, theme },
  });

  return { dailyBidGoal: row.dailyBidGoal, theme: fromDbTheme(row.theme) };
}
