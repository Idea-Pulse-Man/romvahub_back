import { z } from 'zod';
import { isDateOnly, isMonthOnly, toMonthOnly } from '../domain/dates.js';

/**
 * The Resume form lets rows be added blank and filled in later, so dates here
 * accept `''` in a way `bids.schemas.ts` does not.
 */
const optionalDate = z
  .string()
  .max(10)
  .refine((value) => value === '' || isDateOnly(value), 'Must be YYYY-MM-DD or empty.')
  .default('');

/**
 * Work history and education are month precision — a Resume prints "Aug 2024".
 *
 * A full `YYYY-MM-DD` is still accepted and truncated, so a data export taken
 * before the change, or a client that has not caught up, still imports. The day
 * is dropped, which is the only sensible reading of it.
 */
const optionalMonth = z
  .string()
  .max(10)
  .refine(
    (value) => value === '' || isMonthOnly(value) || isDateOnly(value),
    'Must be YYYY-MM or empty.',
  )
  .transform((value) => (value === '' ? '' : toMonthOnly(value)))
  .default('');

const nullableMonth = z
  .string()
  .nullable()
  .refine(
    (value) => value === null || value === '' || isMonthOnly(value) || isDateOnly(value),
    { message: 'Must be YYYY-MM, empty, or null.' },
  )
  .transform((value) => (value ? toMonthOnly(value) : value))
  .default(null);

export const WorkExperienceSchema = z.object({
  id: z.string().max(64).optional(),
  company: z.string().trim().max(200).default(''),
  title: z.string().trim().max(200).default(''),
  location: z.string().trim().max(200).default(''),
  startDate: optionalMonth,
  endDate: nullableMonth,
});

export const EducationSchema = z.object({
  id: z.string().max(64).optional(),
  degree: z.string().trim().max(200).default(''),
  major: z.string().trim().max(200).default(''),
  university: z.string().trim().max(200).default(''),
  location: z.string().trim().max(200).default(''),
  startDate: optionalMonth,
  endDate: nullableMonth,
});

export const ProfileSchema = z.object({
  firstName: z.string().trim().max(100).default(''),
  middleName: z.string().trim().max(100).default(''),
  lastName: z.string().trim().max(100).default(''),
  hasPreferredName: z.boolean().default(false),
  preferredFirstName: z.string().trim().max(100).default(''),
  preferredLastName: z.string().trim().max(100).default(''),
  dateOfBirth: optionalDate,
  resumeTemplateId: z
    .string()
    .trim()
    .max(130)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.docx$/i, 'Not a valid Resume template.')
    .default('default.docx'),
  location: z.string().trim().max(200).default(''),
  addressLine: z.string().trim().max(300).default(''),
  city: z.string().trim().max(100).default(''),
  state: z.string().trim().max(100).default(''),
  zipCode: z.string().trim().max(20).default(''),
  county: z.string().trim().max(100).default(''),
  country: z.string().trim().max(100).default(''),
  timezone: z.string().trim().max(100).default(''),
  linkedinUrl: z.string().trim().max(500).default(''),
  githubUrl: z.string().trim().max(500).default(''),
  portfolioUrl: z.string().trim().max(500).default(''),
  otherUrl: z.string().trim().max(500).default(''),
  // Not `z.email()`: the form is saved mid-edit and a half-typed address must
  // not block saving the rest of the Resume.
  email: z.string().trim().max(254).default(''),
  phone: z.string().trim().max(40).default(''),
  authorizedCountries: z.array(z.string().trim().max(100)).max(50).default([]),
  gender: z.string().trim().max(100).default(''),
  ethnicity: z.string().trim().max(200).default(''),
  disabilityStatus: z.string().trim().max(200).default(''),
  veteranStatus: z.string().trim().max(200).default(''),
  lgbtqIdentity: z.string().trim().max(100).default(''),
  birthYear: z.string().trim().max(4).default(''),
  securityClearance: z.string().trim().max(200).default(''),
  drugTestWillingness: z.string().trim().max(200).default(''),
  noticePeriod: z.string().trim().max(100).default(''),
  openToRelocation: z.string().trim().max(100).default(''),
  inPersonAvailability: z.string().trim().max(100).default(''),
  requireAccommodations: z.string().trim().max(100).default(''),
  workExperience: z.array(WorkExperienceSchema).max(100).default([]),
  education: z.array(EducationSchema).max(100).default([]),
});

export type ProfileInput = z.infer<typeof ProfileSchema>;
