import { z } from 'zod';

export const NotificationIdParamsSchema = z.object({
  id: z.uuid('Not a valid notification id.'),
});

export const CreateNotificationSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required.').max(120),
    message: z.string().trim().min(1, 'Message is required.').max(2_000),
    link: z
      .string()
      .trim()
      .max(500)
      .regex(/^\/(?!\/)/, 'Link must be an internal website path.')
      .optional(),
    recipientIds: z.array(z.uuid('Not a valid recipient id.')).max(500).default([]),
    broadcast: z.boolean().default(false),
    toAdmins: z.boolean().default(false),
  })
  .refine(input => input.broadcast || input.toAdmins || input.recipientIds.length > 0, {
    message: 'Choose at least one recipient.',
    path: ['recipientIds'],
  });

export type NotificationIdParams = z.infer<typeof NotificationIdParamsSchema>;
export type CreateNotificationInput = z.infer<typeof CreateNotificationSchema>;
