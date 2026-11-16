import { z } from 'zod';
import { ProfileSchema } from '../profile/profile.schemas.js';

export const ProfileIdParamsSchema = z.object({
  id: z.uuid('Not a valid profile id.'),
});

/** Create / replace the Resume fields of a first-class Profile. */
export const CreateProfileSchema = ProfileSchema;

/** Replace which User accounts this Profile is shared with. */
export const SetProfileSharesSchema = z.object({
  userIds: z.array(z.uuid('Not a valid user id.')).max(500),
});

export type ProfileIdParams = z.infer<typeof ProfileIdParamsSchema>;
export type CreateProfileInput = z.infer<typeof CreateProfileSchema>;
export type SetProfileSharesInput = z.infer<typeof SetProfileSharesSchema>;
