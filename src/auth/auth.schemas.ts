import { z } from 'zod';

/** The two halves of a credential, shared by login and admin-created accounts. */
export const CredentialsSchema = z.object({
  email: z.email('Must be a valid email address.').max(254),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters.')
    .max(200, 'Password must be at most 200 characters.'),
});

export const LoginSchema = z.object({
  email: z.email('Must be a valid email address.').max(254),
  // Deliberately not length-checked: the rule applies at account creation, and
  // echoing it back on login would confirm nothing useful to an attacker.
  password: z.string().min(1, 'Password is required.'),
});

/**
 * Which screens the account is offered. Sent with the user so the frontend can
 * draw the right navigation on the first paint rather than after a second call.
 *
 * There are exactly two roles. The deployment has one Admin; everyone else is
 * a User. Accounts are created by the Admin — there is no public sign-up.
 */
export const UserRoleSchema = z.enum(['user', 'admin']);

export const AuthUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: UserRoleSchema,
  createdAt: z.iso.datetime(),
});

export const AuthResponseSchema = z.object({
  user: AuthUserSchema,
  /**
   * Also set as httpOnly cookies for the website. Returned in the body so API
   * clients (Swagger, the Chrome scraper) can send `Authorization: Bearer …`
   * without reading cookies.
   */
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
});

export type Credentials = z.infer<typeof CredentialsSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type UserRole = z.infer<typeof UserRoleSchema>;
