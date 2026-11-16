import { z } from 'zod';

const PASSWORD = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(200, 'Password must be at most 200 characters.');

export const UserAccountStatusSchema = z.enum(['active', 'suspended']);

/**
 * Creating a platform User (login account). Credentials only — Profiles are a
 * separate concept and are not filled in here. Role is always `user`; the sole
 * Admin is created/promoted via `yarn admin`, not this endpoint. New accounts
 * start `active`.
 */
export const CreateUserSchema = z.object({
  email: z.email('Must be a valid email address.').max(254),
  password: PASSWORD,
});

/**
 * Every field optional: change email, set a new password, or change account
 * status (active / suspended). Role cannot be changed here.
 */
export const UpdateUserSchema = z
  .object({
    email: z.email('Must be a valid email address.').max(254).optional(),
    password: PASSWORD.optional(),
    status: UserAccountStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one of email, password or status.',
  });

export const UserIdParamsSchema = z.object({ id: z.uuid('Not a valid user id.') });

/** Replace which application Profiles are shared with one User account. */
export const SetUserSharedProfilesSchema = z.object({
  profileIds: z.array(z.uuid('Not a valid profile id.')).max(500),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type UserIdParams = z.infer<typeof UserIdParamsSchema>;
export type SetUserSharedProfilesInput = z.infer<typeof SetUserSharedProfilesSchema>;
export type UserAccountStatus = z.infer<typeof UserAccountStatusSchema>;
