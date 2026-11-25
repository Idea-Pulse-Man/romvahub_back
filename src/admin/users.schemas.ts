import { z } from 'zod';
import { UserKindSchema, UserRoleSchema } from '../auth/auth.schemas.js';

const PASSWORD = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(200, 'Password must be at most 200 characters.');

export const UserAccountStatusSchema = z.enum(['active', 'suspended']);

/**
 * Creating a platform User (login account). Credentials only — Profiles are a
 * separate concept and are not filled in here. Role defaults to `user` and
 * kind to `bidder`; any admin may make another admin. New accounts start
 * `active`.
 */
export const CreateUserSchema = z.object({
  email: z.email('Must be a valid email address.').max(254),
  password: PASSWORD,
  role: UserRoleSchema.default('user'),
  kind: UserKindSchema.default('bidder'),
});

/**
 * Every field optional: change email, set a new password, change account
 * status (active / suspended), role (admin / user) or kind (bidder / caller).
 * Any admin may change roles, but not their own and not the Super Admin's.
 */
export const UpdateUserSchema = z
  .object({
    email: z.email('Must be a valid email address.').max(254).optional(),
    password: PASSWORD.optional(),
    status: UserAccountStatusSchema.optional(),
    role: UserRoleSchema.optional(),
    kind: UserKindSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one of email, password, status, role or kind.',
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
