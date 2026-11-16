import { z } from 'zod';

export const ParseJobSchema = z.object({
  url: z.url('Must be a valid URL.').max(2048),
});

export type ParseJobInput = z.infer<typeof ParseJobSchema>;
