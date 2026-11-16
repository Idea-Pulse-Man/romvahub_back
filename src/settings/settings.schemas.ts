import { z } from 'zod';

export const AppSettingsSchema = z.object({
  dailyBidGoal: z
    .number()
    .int('Daily bid goal must be a whole number.')
    .min(0)
    .max(10_000)
    .default(100),
  theme: z.enum(['light', 'dark']).default('light'),
});

export type AppSettingsInput = z.infer<typeof AppSettingsSchema>;
