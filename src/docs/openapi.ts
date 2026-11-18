import { z } from 'zod';
import { AuthUserSchema, LoginSchema, UserRoleSchema } from '../auth/auth.schemas.js';
import { AiSettingsSchema } from '../ai-config/ai-config.schemas.js';
import { UserAiPromptsSchema } from '../ai-config/user-prompts.schemas.js';
import { CreateUserSchema, UpdateUserSchema } from '../admin/users.schemas.js';
import {
  BidStatusSchema,
  BulkDeleteSchema,
  BulkStatusSchema,
  CommitmentDetailsSchema,
  CreateBidSchema,
  InterviewRoundSchema,
  RateTypeSchema,
  UpdateBidSchema,
  PipelineQuerySchema,
  ListBidsQuerySchema,
} from '../bids/bids.schemas.js';
import { DashboardQuerySchema } from '../dashboard/dashboard.schemas.js';
import { ParseJobSchema } from '../jobs/jobs.schemas.js';
import { ChatSchema, ChatTranscriptSchema } from '../questions/questions.schemas.js';
import {
  GenerateResumeSchema,
  ListModelsSchema,
  RenderResumeSchema,
  ResumePayloadSchema,
} from '../resume/resume.schemas.js';
import {
  CoverLetterPayloadSchema,
  GenerateCoverLetterSchema,
  RenderCoverLetterSchema,
} from '../cover-letter/cover-letter.schemas.js';
import { BID_STATUSES } from '../domain/types.js';
import { ImportBundleSchema } from '../data/data.schemas.js';
import { EducationSchema, ProfileSchema, WorkExperienceSchema } from '../profile/profile.schemas.js';
import { AppSettingsSchema } from '../settings/settings.schemas.js';

/**
 * The spec is generated from the same Zod schemas the routes validate with, so
 * it cannot drift from what the API actually accepts. Response schemas are
 * declared here rather than in the feature modules — they exist only to be
 * documented.
 */

// ------------------------------------------------------------- response shapes

const BidCandidateSchema = z.object({
  userId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  photoUrl: z.url().optional(),
});

const ResumeFileInfoSchema = z.object({
  name: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  updatedAt: z.string(),
});

const BidResponseSchema = z.object({
  id: z.uuid(),
  number: z
    .number()
    .int()
    .describe(
      'The number of the application within its filing scope (its Profile, or the rows of its ' +
        'owner when it has none), counted up from 1 in the order applications were filed.',
    ),
  candidate: BidCandidateSchema.optional().describe(
    'Who the application is filed under. Always the caller for a plain account; ' +
      "any profile in an admin's list.",
  ),
  company: z.string(),
  role: z.string(),
  jobUrl: z.string().optional(),
  hasResume: z.boolean().optional(),
  resumeFingerprint: z.string().optional(),
  resumeFiles: z
    .object({
      pdf: ResumeFileInfoSchema.optional(),
      docx: ResumeFileInfoSchema.optional(),
    })
    .optional()
    .describe(
      'The Resume files synced up from the Resume Builder folder, by format: name and SHA-256, ' +
        'never the bytes. `GET /api/bids/{id}/resume?format=` serves them.',
    ),
  hasCoverLetter: z.boolean().optional(),
  proofUrl: z
    .url()
    .optional()
    .describe(
      'A short-lived signed link to the screenshot of the job site\'s confirmation page, ' +
        'uploaded when the application was filed. Absent when none was uploaded.',
    ),
  chatMessageCount: z
    .number()
    .optional()
    .describe(
      'How many turns the conversation about this application ran to. The ' +
        'transcript is at GET /api/bids/{id}/chat.',
    ),
  location: z.string(),
  jobDescription: z.string().optional(),
  postedAt: z.iso.datetime().optional(),
  rateType: RateTypeSchema.optional(),
  rateAmount: z.number().optional(),
  bidDate: z.string(),
  status: BidStatusSchema,
  followUpDate: z.string().optional(),
  resumeVersion: z.string().optional(),
  notes: z.string().optional(),
  commitmentDetails: CommitmentDetailsSchema.optional(),
  interviews: z.array(InterviewRoundSchema).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const BidPageSchema = z.object({
  items: z.array(BidResponseSchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0).describe('Rows matching the filters across every page.'),
  totalPages: z.number().int().min(1).describe('At least 1, even when `total` is 0.'),
});

const PipelineStageSchema = z.object({
  status: BidStatusSchema,
  total: z.number().int().min(0).describe('Applications at this status, across every page.'),
  items: z.array(BidResponseSchema).describe('The first page, most recently updated first.'),
});

const PipelineBoardSchema = z.object({
  pageSize: z.number().int().min(1),
  stages: z.array(PipelineStageSchema).describe('Every status in funnel order, empty ones included.'),
});

const ProfileResponseSchema = z.object({
  firstName: z.string(),
  middleName: z.string(),
  lastName: z.string(),
  hasPreferredName: z.boolean(),
  preferredFirstName: z.string(),
  preferredLastName: z.string(),
  dateOfBirth: z.string(),
  location: z.string(),
  addressLine: z.string(),
  city: z.string(),
  state: z.string(),
  zipCode: z.string(),
  county: z.string(),
  country: z.string(),
  timezone: z.string(),
  linkedinUrl: z.string(),
  githubUrl: z.string(),
  portfolioUrl: z.string(),
  otherUrl: z.string(),
  email: z.string(),
  phone: z.string(),
  authorizedCountries: z.array(z.string()),
  gender: z.string(),
  ethnicity: z.string(),
  disabilityStatus: z.string(),
  veteranStatus: z.string(),
  lgbtqIdentity: z.string(),
  birthYear: z.string(),
  securityClearance: z.string(),
  drugTestWillingness: z.string(),
  noticePeriod: z.string(),
  openToRelocation: z.string(),
  inPersonAvailability: z.string(),
  requireAccommodations: z.string(),
  photoUrl: z
    .url()
    .optional()
    .describe(
      'A signed, short-lived link to the candidate photo. Absent when no photo has been ' +
        'uploaded, or when this deployment has no S3 bucket configured. Read-only: PUT ignores it.',
    ),
  workExperience: z.array(WorkExperienceSchema.required({ id: true })),
  education: z.array(EducationSchema.required({ id: true })),
});

const AdminUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: UserRoleSchema,
  status: z.enum(['active', 'suspended']),
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
  lastLoginIp: z.string().nullable(),
  lastLoginLocation: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  photoUrl: z.url().optional(),
  dateOfBirth: z.string(),
  bidCount: z.number().int(),
});

const LoginHistoryEntrySchema = z.object({
  id: z.uuid(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  acceptLanguage: z.string().nullable(),
  country: z.string().nullable(),
  countryCode: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  timezone: z.string().nullable(),
  isp: z.string().nullable(),
  org: z.string().nullable(),
  locationLabel: z.string().nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  deviceType: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const AdminUserDetailSchema = AdminUserSchema.extend({ profile: ProfileResponseSchema });

const AiSettingsViewSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'deepseek']),
  model: z.string(),
  systemPrompt: z.string(),
  coverLetterPrompt: z.string(),
  hasApiKey: z.boolean(),
  keySource: z.enum(['database', 'environment', 'none']),
  overrides: z.object({
    provider: z.boolean(),
    model: z.boolean(),
    systemPrompt: z.boolean(),
    coverLetterPrompt: z.boolean(),
  }),
  defaults: z.object({
    provider: z.enum(['openai', 'anthropic', 'gemini', 'deepseek']),
    model: z.string(),
    keyVariable: z.string(),
  }),
  updatedAt: z.iso.datetime().nullable(),
});

const UserAiPromptsViewSchema = z.object({
  userId: z.uuid(),
  systemPrompt: z.string(),
  coverLetterPrompt: z.string(),
  overrides: z.object({ systemPrompt: z.boolean(), coverLetterPrompt: z.boolean() }),
  defaults: z.object({ systemPrompt: z.string(), coverLetterPrompt: z.string() }),
  updatedAt: z.iso.datetime().nullable(),
});

const DayCountSchema = z.object({ date: z.string(), count: z.number().int() });

const DashboardResponseSchema = z.object({
  totalApplications: z.number().int(),
  statusBreakdown: z.array(z.object({ status: BidStatusSchema, count: z.number().int() })),
  dailyGoal: z.number().int(),
  todayCount: z.number().int(),
  dailyVolume: z.array(DayCountSchema),
  activity: z.object({ from: z.string(), to: z.string(), days: z.array(DayCountSchema) }),
  upcomingInterviews: z.array(
    z.object({
      bidId: z.uuid(),
      company: z.string(),
      role: z.string(),
      stage: BidStatusSchema,
      dateTime: z.string(),
    }),
  ),
  startedContracts: z.array(
    z.object({
      bidId: z.uuid(),
      company: z.string(),
      role: z.string(),
      rate: z.number().nullable(),
      rateType: RateTypeSchema.nullable(),
      startedOn: z.string(),
    }),
  ),
});

const DataBundleSchema = z.object({
  bids: z.array(BidResponseSchema),
  profile: ProfileResponseSchema,
  settings: AppSettingsSchema,
});

const ImportResultSchema = z.object({
  mode: z.enum(['merge', 'replace']),
  bidsImported: z.number().int(),
  bidsDeleted: z.number().int(),
  profileImported: z.boolean(),
  settingsImported: z.boolean(),
});

const ParsedJobSchema = z.object({
  url: z.url(),
  description: z.string(),
  truncated: z.boolean(),
  strategy: z.enum(['json-ld', 'container', 'readability', 'page', 'reader', 'none']),
  title: z.string().optional(),
  company: z.string().optional(),
  location: z.string().optional(),
  employmentType: z.string().optional(),
  datePosted: z.string().optional(),
});

const GeneratedResumeSchema = z.object({ document: ResumePayloadSchema });

const GeneratedCoverLetterSchema = z.object({ document: CoverLetterPayloadSchema });

const ChatTranscriptResponseSchema = z.object({ messages: ChatTranscriptSchema });

const AvailableModelsSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'deepseek']),
  models: z.array(z.object({ id: z.string(), displayName: z.string() })),
  defaultModel: z.string(),
});

const ErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
  }),
});

// ------------------------------------------------------------- generation

type JsonSchema = Record<string, unknown>;

function toSchema(schema: z.ZodType, io: 'input' | 'output' = 'output'): JsonSchema {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    // A few schemas use `preprocess`/`refine`, which have no JSON Schema
    // equivalent. Documenting them as unconstrained beats failing to generate.
    unrepresentable: 'any',
  }) as JsonSchema;
}

const ProofMatchSchema = z.object({
  match: z
    .object({ identical: z.boolean(), difference: z.number() })
    .describe(
      '`identical` is true when the two screenshots are the same pixels once margin, ' +
        'container and metadata are set aside — the same picture, whatever file it arrived in. ' +
        'Otherwise it is the same picture through a lossy encoder, and `difference` is how far ' +
        'apart the worst cell of their colour grids is: 0 for identical, 1 for black against ' +
        'white, and never more than 0.045 in a match.',
    ),
  bid: BidResponseSchema.describe('The application carrying the other screenshot.'),
});

const components = {
  ProofMatch: toSchema(ProofMatchSchema),
  LoginRequest: toSchema(LoginSchema, 'input'),
  AuthUser: toSchema(AuthUserSchema),
  Bid: toSchema(BidResponseSchema),
  BidPage: toSchema(BidPageSchema),
  PipelineBoard: toSchema(PipelineBoardSchema),
  CreateBid: toSchema(CreateBidSchema, 'input'),
  UpdateBid: toSchema(UpdateBidSchema, 'input'),
  BulkStatus: toSchema(BulkStatusSchema, 'input'),
  BulkDelete: toSchema(BulkDeleteSchema, 'input'),
  Profile: toSchema(ProfileResponseSchema),
  ProfileInput: toSchema(ProfileSchema, 'input'),
  AppSettings: toSchema(AppSettingsSchema, 'input'),
  Dashboard: toSchema(DashboardResponseSchema),
  DataBundle: toSchema(DataBundleSchema),
  ImportBundle: toSchema(ImportBundleSchema, 'input'),
  ImportResult: toSchema(ImportResultSchema),
  GenerateResumeRequest: toSchema(GenerateResumeSchema, 'input'),
  RenderResumeRequest: toSchema(RenderResumeSchema, 'input'),
  GeneratedResume: toSchema(GeneratedResumeSchema),
  GenerateCoverLetterRequest: toSchema(GenerateCoverLetterSchema, 'input'),
  RenderCoverLetterRequest: toSchema(RenderCoverLetterSchema, 'input'),
  GeneratedCoverLetter: toSchema(GeneratedCoverLetterSchema),
  ChatRequest: toSchema(ChatSchema, 'input'),
  ChatTranscript: toSchema(ChatTranscriptResponseSchema),
  ListModelsRequest: toSchema(ListModelsSchema, 'input'),
  AvailableModels: toSchema(AvailableModelsSchema),
  ParseJobRequest: toSchema(ParseJobSchema, 'input'),
  ParsedJob: toSchema(ParsedJobSchema),
  AdminUser: toSchema(AdminUserSchema),
  AdminUserDetail: toSchema(AdminUserDetailSchema),
  LoginHistoryEntry: toSchema(LoginHistoryEntrySchema),
  CreateUser: toSchema(CreateUserSchema, 'input'),
  UpdateUser: toSchema(UpdateUserSchema, 'input'),
  AiSettings: toSchema(AiSettingsViewSchema),
  AiSettingsInput: toSchema(AiSettingsSchema, 'input'),
  UserAiPrompts: toSchema(UserAiPromptsViewSchema),
  UserAiPromptsInput: toSchema(UserAiPromptsSchema, 'input'),
  Error: toSchema(ErrorSchema),
} satisfies Record<string, JsonSchema>;

const ref = (name: keyof typeof components) => ({ $ref: `#/components/schemas/${name}` });

const json = (name: keyof typeof components) => ({
  content: { 'application/json': { schema: ref(name) } },
});

const jsonArray = (name: keyof typeof components) => ({
  content: { 'application/json': { schema: { type: 'array', items: ref(name) } } },
});

const errorResponse = (description: string) => ({ description, ...json('Error') });

const AUTH_ERRORS = {
  '401': errorResponse('Not authenticated, or the access token has expired.'),
};

const COMMON_ERRORS = {
  '400': errorResponse('Request validation failed.'),
  ...AUTH_ERRORS,
};

/** Query parameters, derived from the same schemas the routes validate with. */
function queryParams(schema: z.ZodObject, required: string[] = []) {
  const jsonSchema = toSchema(schema, 'input');
  const properties = (jsonSchema.properties ?? {}) as Record<string, JsonSchema>;

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: 'query',
    required: required.includes(name),
    schema: propertySchema,
    ...(typeof propertySchema.description === 'string'
      ? { description: propertySchema.description }
      : {}),
  }));
}

const userIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const bidIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'RemoteOps API',
    version: '0.1.0',
    description: [
      'Backend for the RemoteOps frontend.',
      '',
      'Every route below `/api/auth` requires authentication. The browser flow uses',
      'httpOnly cookies set by `/api/auth/login`; for `curl` and the "Try it out"',
      'button here, an `Authorization: Bearer <accessToken>` header also works.',
      '',
      'Dates come in two forms and neither carries a timezone: calendar dates are',
      '`YYYY-MM-DD`, and interview times are `YYYY-MM-DDTHH:mm:ss` local wall-clock.',
      '`createdAt` / `updatedAt` are true instants in full ISO-8601 with `Z`.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'Auth', description: 'Registration, sessions and token rotation.' },
    { name: 'Bids', description: 'The one first-class entity: a job application.' },
    { name: 'Profile', description: 'The single Resume profile, global per user.' },
    { name: 'Settings', description: 'Daily bid goal and theme.' },
    { name: 'Dashboard', description: 'Server-side aggregates for the Dashboard screen.' },
    { name: 'Data', description: 'Whole-account export, import and reset.' },
    { name: 'Jobs', description: 'Reading a job posting from its public URL.' },
    { name: 'Resume', description: 'Writing a Resume for one application with an AI platform.' },
    {
      name: 'Cover letter',
      description:
        'The step after the Resume: a letter written from it and from the same posting, laid ' +
        'out on the same page.',
    },
    {
      name: 'Questions',
      description:
        "The conversation about one application: the extra questions an employer's form asks " +
        'beside the Resume, answered in the applicant\'s voice.',
    },
    {
      name: 'Admin',
      description:
        'Administrator-only: managing accounts and their profiles, and the deployment-wide ' +
        'AI settings. Every route here answers 403 for a plain account.',
    },
  ],
  components: {
    schemas: components,
    securitySchemes: {
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ge_access' },
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
  security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['Dashboard'],
        summary: 'Liveness and database connectivity check',
        security: [],
        responses: { '200': { description: 'The service is up.' } },
      },
    },

    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Start a session',
        description:
          'Accounts are created by an administrator — there is no public registration.',
        security: [],
        requestBody: { required: true, ...json('LoginRequest') },
        responses: {
          '200': { description: 'Signed in; auth cookies set.', ...json('AuthUser') },
          '401': errorResponse('Incorrect email or password.'),
          '429': errorResponse('Too many attempts.'),
        },
      },
    },

    '/api/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate the refresh token and issue a new access token',
        description:
          'Replaying an already-rotated token revokes every token for that user — it is ' +
          'treated as evidence the token was stolen.',
        security: [],
        responses: {
          '200': { description: 'New cookies set.', ...json('AuthUser') },
          '401': errorResponse('Missing, expired, or already-used refresh token.'),
        },
      },
    },

    '/api/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Revoke the refresh token and clear cookies',
        security: [],
        responses: { '204': { description: 'Signed out. Calling this twice is not an error.' } },
      },
    },

    '/api/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'The currently authenticated account',
        responses: {
          '200': { description: 'The current user.', ...json('AuthUser') },
          ...AUTH_ERRORS,
        },
      },
    },

    '/api/bids': {
      get: {
        tags: ['Bids'],
        summary: 'List bids',
        description:
          "An account's own applications — or every profile's, for an admin, each row naming " +
          "its `candidate`. The query parameters are the server-side equivalents of the " +
          "Applications page's search and filters.",
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' },
            description: 'Case-insensitive substring match on company or role.' },
          { name: 'company', in: 'query', schema: { type: 'string' },
            description: 'The whole company name, matched as the same employer (case, punctuation, a ' +
              'leading "The" and a trailing legal form ignored). The application form asks this after ' +
              'reading a posting, to warn that a profile in scope already applied there.' },
          { name: 'jobUrl', in: 'query', schema: { type: 'string' },
            description: 'The same posting by link (case, #fragment, utm_* parameters and a trailing slash ' +
              'ignored). The scraper extension asks this before saving, so a posting already filed is skipped.' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: [...BID_STATUSES] },
            description: 'Exact status match.' },
          { name: 'from', in: 'query', schema: { type: 'string' },
            description: 'Earliest bidDate, inclusive (YYYY-MM-DD).' },
          { name: 'to', in: 'query', schema: { type: 'string' },
            description: 'Latest bidDate, inclusive (YYYY-MM-DD).' },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['bidDate', 'updatedAt', 'number'] },
            description: 'Ordering. `bidDate` (the default) is newest first; `updatedAt` is the Pipeline board\'s, ' +
              'so a card just moved sits at the top of its column; `number` is the Applications table\'s: ' +
              'the order the applications were filed in, #1 first.' },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 },
            description: '1-based. Sending it, or `pageSize`, answers with a `BidPage` rather than the whole list.' },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 },
            description: 'Rows per page. Defaults to 25 when paging.' },
        ],
        responses: {
          '200': {
            description:
              'Newest first. The whole list as an array when neither `page` nor `pageSize` was ' +
              'sent; one page of it as a `BidPage` when either was.',
            content: {
              'application/json': {
                schema: { oneOf: [{ type: 'array', items: ref('Bid') }, ref('BidPage')] },
              },
            },
          },
          ...COMMON_ERRORS,
        },
      },
      post: {
        tags: ['Bids'],
        summary: 'Create a bid',
        requestBody: { required: true, ...json('CreateBid') },
        responses: {
          '201': { description: 'The created bid.', ...json('Bid') },
          '422': errorResponse(
            'An interview stage was requested without a matching scheduled interview round.',
          ),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/bids/pipeline': {
      get: {
        tags: ['Bids'],
        summary: "The Pipeline board's opening state",
        description:
          'Every status in funnel order with how many applications sit at it and the first ' +
          '`pageSize` of them, most recently updated first. The rest of a column is read from ' +
          '`GET /api/bids?status=…&sort=updatedAt&page=2&pageSize=…`, which orders identically. ' +
          "An account's own applications, or every profile's for an admin.",
        parameters: queryParams(PipelineQuerySchema),
        responses: {
          '200': { description: 'The board.', ...json('PipelineBoard') },
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/bids/{id}': {
      get: {
        tags: ['Bids'],
        summary: 'Fetch one bid',
        parameters: [bidIdParam],
        responses: {
          '200': { description: 'The bid.', ...json('Bid') },
          '404': errorResponse('No such bid, or it belongs to another account.'),
          ...COMMON_ERRORS,
        },
      },
      patch: {
        tags: ['Bids'],
        summary: 'Update a bid',
        description:
          'Partial update. Supplying `interviews` replaces the whole set; ' +
          '`commitmentDetails: null` clears the commitment. Unknown keys — including ' +
          '`id`, `createdAt` and `updatedAt` — are ignored.',
        parameters: [bidIdParam],
        requestBody: { required: true, ...json('UpdateBid') },
        responses: {
          '200': { description: 'The updated bid.', ...json('Bid') },
          '404': errorResponse('No such bid, or it belongs to another account.'),
          '422': errorResponse(
            'The resulting status is an interview stage with no scheduled round.',
          ),
          ...COMMON_ERRORS,
        },
      },
      delete: {
        tags: ['Bids'],
        summary: 'Delete a bid',
        parameters: [bidIdParam],
        responses: {
          '204': { description: 'Deleted.' },
          '404': errorResponse('No such bid, or it belongs to another account.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/bids/bulk/status': {
      post: {
        tags: ['Bids'],
        summary: 'Move many bids to one status',
        description:
          'Ids not owned by the caller are skipped silently. Moving into an interview ' +
          'stage requires `interviewDateTime`, which is applied to every selected bid.',
        requestBody: { required: true, ...json('BulkStatus') },
        responses: {
          '200': {
            description: 'How many bids were updated.',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { updated: { type: 'integer' } } },
              },
            },
          },
          '422': errorResponse('An interview stage was requested without `interviewDateTime`.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/bids/bulk/delete': {
      post: {
        tags: ['Bids'],
        summary: 'Delete many bids',
        requestBody: { required: true, ...json('BulkDelete') },
        responses: {
          '200': {
            description: 'How many bids were deleted.',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { deleted: { type: 'integer' } } },
              },
            },
          },
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/jobs/parse': {
      post: {
        tags: ['Jobs'],
        summary: 'Read a job posting from its URL and return it as Markdown',
        description: [
          'Fetches the page, finds the posting — schema.org `JobPosting` JSON-LD first, then a',
          'known container, then the densest block of non-link text, then the page as a whole —',
          'and converts it to Markdown for the application form to fill in. When the page cannot',
          'be read that way (a board that refuses non-browser clients, or one that renders only',
          'in JavaScript) the posting is read through the configured reader service instead;',
          '`strategy` says which source won. Nothing is stored: the result becomes a bid only if',
          'the user saves one.',
          '',
          'Only public `http(s)` URLs are fetched. A URL that resolves to a private or loopback',
          'address is rejected, as is one that redirects to such an address.',
        ].join('\n'),
        requestBody: { required: true, ...json('ParseJobRequest') },
        responses: {
          '200': { description: 'The posting, as Markdown.', ...json('ParsedJob') },
          '422': errorResponse(
            'The URL is not fetchable (private address, wrong content type), or the page ' +
              'carries no job description.',
          ),
          '429': errorResponse('Too many URLs parsed in the last minute.'),
          '502': errorResponse(
            'The site could not be reached, timed out, or refused the request, and the reader ' +
              'service could not read it either.',
          ),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/bids/{id}/chat': {
      get: {
        tags: ['Bids'],
        summary: 'The conversation held while filling in this application',
        description: [
          'Its own request rather than a field on the bid, for the same reason the Resume is:',
          'every screen loads the whole bid list, and a transcript per row would be paid for by',
          'all of them and read by almost none. The bid carries `chatMessageCount`; this',
          'carries the text.',
          '',
          'An application that had no conversation answers with an empty list rather than 404.',
        ].join('\n'),
        parameters: [bidIdParam],
        responses: {
          '200': { description: 'The transcript, oldest first.', ...json('ChatTranscript') },
          '404': errorResponse('No such application.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/bids/{id}/proof': {
      post: {
        tags: ['Bids'],
        summary: 'Upload the proof screenshot',
        description:
          'The screenshot of the job site\'s "thank you for applying" page, which is how an ' +
          'admin checks that a job was really applied to. Multipart, one file in the `proof` ' +
          'field: JPEG, PNG, WebP or GIF, at most 5 MB. Replaces whatever is stored and deletes ' +
          'the old object. The whole bid comes back, with a freshly signed `proofUrl`. Refused ' +
          "with 409 `DUPLICATE_PROOF` — nothing stored — when it is the same picture as one already " +
          "on another of the same profile's applications (the bid's owner's), compared by the pixels " +
          '(a hash of them, plus a small colour grid for the same picture re-encoded), not by file ' +
          'name, size or metadata, so a copy re-saved, renamed, padded or put through a lossy ' +
          'encoder is still caught; ' +
          "`error.data.matches` lists them as `ProofMatch`es. Other profiles' screenshots are not " +
          'compared. Anyone who can write the bid can replace its proof.',
        parameters: [bidIdParam],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['proof'],
                properties: { proof: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'The bid, with the new screenshot.', ...json('Bid') },
          '400': errorResponse('No file, an unsupported type, larger than 5 MB, or not decodable as an image.'),
          '409': errorResponse(
            "`DUPLICATE_PROOF`: the same picture is already on another of the profile's applications; " +
              '`error.data.matches` names them. Nothing was stored.',
          ),
          '404': errorResponse('No such bid, or it belongs to another account.'),
          '503': errorResponse('No S3 bucket is configured for this deployment.'),
          ...AUTH_ERRORS,
        },
      },
      delete: {
        tags: ['Bids'],
        summary: 'Remove the proof screenshot',
        description:
          'Admin-only: the screenshot is what a candidate is checked against, so it is not ' +
          'theirs to take back — they may replace it, which is the only reason to.',
        parameters: [bidIdParam],
        responses: {
          '200': { description: 'The bid, with no screenshot.', ...json('Bid') },
          '403': errorResponse('This action is restricted to administrators.'),
          '404': errorResponse('No such bid, or it belongs to another account.'),
          ...AUTH_ERRORS,
        },
      },
    },

    '/api/bids/proof/check': {
      post: {
        tags: ['Bids'],
        summary: 'Is this screenshot already on one of the profile\'s applications?',
        description:
          'The check the form runs the moment a screenshot is picked, pasted or dropped — before ' +
          'there is an application to store it on. The same comparison the upload makes before ' +
          'refusing a duplicate, by the pixels, with nothing stored. Multipart: the file in `proof`, plus optional fields ' +
          '`bidId` (the application being edited, left out of the comparison) and `userId` (the ' +
          'candidate an admin is filing for; ignored for a plain account). Compared with the ' +
          "application's owner when editing, else the named candidate for an admin, else the caller.",
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['proof'],
                properties: {
                  proof: { type: 'string', format: 'binary' },
                  bidId: { type: 'string', format: 'uuid' },
                  userId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Closest first; empty when the picture is on none of them.',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ProofMatch' } } } },
          },
          '400': errorResponse('No file, an unsupported type, larger than 5 MB, or not decodable as an image.'),
          '404': errorResponse('`bidId` names no bid of the caller\'s.'),
          ...AUTH_ERRORS,
        },
      },
    },

    '/api/bids/{id}/proof/matches': {
      get: {
        tags: ['Bids'],
        summary: "The same profile's other applications whose screenshot is the same picture (from before the rule)",
        description:
          'An upload that would make such a pair is refused, so this finds only what was there ' +
          'before the rule — screenshots uploaded before fingerprints existed and since backfilled ' +
          '(`yarn proofs:fingerprint`) — for the details view. Compared from the stored ' +
          'fingerprints, so no screenshot is fetched. Empty for an application with no screenshot.',
        parameters: [bidIdParam],
        responses: {
          '200': {
            description: 'Closest first.',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ProofMatch' } } } },
          },
          '404': errorResponse('No such bid, or it belongs to another account.'),
          ...AUTH_ERRORS,
        },
      },
    },

    '/api/bids/{id}/resume': {
      get: {
        tags: ['Bids'],
        summary: "Download an application's stored Resume",
        description: [
          'Renders the Resume saved against this bid, as PDF or as Word.',
          '',
          'Costs nothing at the AI platform: the document was stored when the application was',
          'saved, so the same one downloads as either format, as often as wanted — and it is',
          'always the Resume actually generated for this application rather than a fresh one,',
          'which would say something different.',
          '',
          'A bid with no stored Resume answers `404`: it exists, it simply predates Resume',
          'generation or was saved without one. `hasResume` on the bid says which.',
        ].join('\n'),
        parameters: [
          bidIdParam,
          {
            name: 'format',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['pdf', 'docx'], default: 'pdf' },
          },
        ],
        responses: {
          '200': {
            description: 'The Resume file.',
            content: {
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          '404': errorResponse('No such application, or no Resume stored against it.'),
          '502': errorResponse('The PDF could not be printed. Word still works.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/bids/{id}/cover-letter': {
      get: {
        tags: ['Bids'],
        summary: "Download an application's stored cover letter",
        description: [
          'Renders the cover letter saved against this bid, as PDF or as Word — the Resume',
          'route\'s twin, on the same terms.',
          '',
          'Costs nothing at the AI platform: the letter was stored when the application was',
          'saved, so the same one downloads as either format, as often as wanted.',
          '',
          'The letter is dated with the application\'s own `bidDate`, not the day it is',
          'downloaded — a letter printed months later should still say when it was written.',
          '',
          'A bid with no stored letter answers `404`: writing one is an optional step, so most',
          'applications have none. `hasCoverLetter` on the bid says which.',
        ].join('\n'),
        parameters: [
          bidIdParam,
          {
            name: 'format',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['pdf', 'docx'], default: 'pdf' },
          },
        ],
        responses: {
          '200': {
            description: 'The cover letter file.',
            content: {
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          '404': errorResponse('No such application, or no cover letter stored against it.'),
          '502': errorResponse('The PDF could not be printed. Word still works.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/questions/chat': {
      post: {
        tags: ['Questions'],
        summary: 'Continue the conversation about one application',
        description: [
          'The chat behind the application form\'s drawer: the free-text boxes an employer asks',
          'beside the Resume upload, answered in the applicant\'s own voice and ready to paste.',
          '',
          '**Answers as `text/event-stream`, not JSON.** A paragraph that arrives all at once',
          'twenty seconds later reads as a hung page. The frames are `delta` (`{ text }`, a',
          'fragment of the reply), `done` (the reply is complete) and `error` (`{ message }`).',
          'A stream that ends without `done` failed — treat it as one.',
          '',
          '**A rejected request is still a status.** A blank message, a missing job description',
          'or an unconfigured platform is answered as JSON with a 4xx or 5xx, because nothing',
          'has been written yet. Only a failure *after* the reply began is an `error` frame:',
          'by then the status line is long gone.',
          '',
          '**Nothing is stored, and there is no session.** The application and the whole',
          'transcript travel on every turn, which is what lets the drawer work on an',
          'application that has not been saved yet, and what lets the Resume change',
          'mid-conversation with nothing to invalidate. The transcript is saved with the bid',
          'as `applicationChat` when the form is saved.',
        ].join('\n'),
        requestBody: { required: true, ...json('ChatRequest') },
        responses: {
          '200': {
            description: 'The reply, streamed.',
            content: {
              'text/event-stream': {
                schema: { type: 'string' },
                example:
                  'event: delta\ndata: {"text":"6 years"}\n\n' +
                  'event: delta\ndata: {"text":", most recently at "}\n\n' +
                  'event: done\ndata: {}\n\n',
              },
            },
          },
          '429': errorResponse('Too many messages in the last minute.'),
          '503': errorResponse('No API key is configured for the selected AI provider.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/resume/generate': {
      post: {
        tags: ['Resume'],
        summary: "Write the Resume's content for one application",
        description: [
          'Sends the company, the job title and the job description to the configured AI',
          'platform — OpenAI, Anthropic, Google or DeepSeek, chosen by `AI_PROVIDER` — and returns the',
          "document it writes. Rendering that document into a file is `/api/resume/render`.",
          '',
          'The system prompt is server-side and is never returned by this or any other route.',
          'The three fields in the request body are the only thing about the application the',
          'model is given — the profile is not sent, and is only used when rendering.',
          '',
          'Nothing is stored. The `X-Resume-Provider` and `X-Resume-Model` response headers',
          'name what wrote it.',
        ].join('\n'),
        requestBody: { required: true, ...json('GenerateResumeRequest') },
        responses: {
          '200': { description: "The Resume's content.", ...json('GeneratedResume') },
          '429': errorResponse('Too many Resumes generated in the last minute.'),
          '502': errorResponse('The AI platform failed, declined, or returned an unusable Resume.'),
          '503': errorResponse('No API key is configured for the selected AI provider.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/resume/render': {
      post: {
        tags: ['Resume'],
        summary: 'Render a generated Resume as PDF or Word',
        description: [
          'Lays the generated document out in the Resume template and returns the file.',
          '',
          'Separate from generation so that a second format costs nothing: the AI is paid for',
          'once and both files come from the one answer.',
          '',
          'The document travels with the request; the name, contact line, employers and',
          'education come from the signed-in account\'s profile and cannot be supplied by a',
          'client. `pdf` is printed from the template\'s own stylesheet through headless',
          'Chromium, `docx` is built with the same measurements stated in Word\'s terms.',
        ].join('\n'),
        requestBody: { required: true, ...json('RenderResumeRequest') },
        responses: {
          '200': {
            description: 'The Resume file.',
            content: {
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          '429': errorResponse('Too many Resumes rendered in the last minute.'),
          '502': errorResponse('The PDF could not be printed. Word still works.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/resume/models': {
      post: {
        tags: ['Resume'],
        summary: 'List the models a platform will let this key use',
        description: [
          'For the model picker: choose a platform, supply a key, pick from what comes back.',
          '',
          '`apiKey` is optional. Supplied, it is used for this one call and discarded — nothing',
          'stores it and nothing logs it, which is what lets a key be checked before it is',
          'saved anywhere. Omitted, the key configured for that platform is used instead, so',
          'the route is usable before any admin screen exists.',
          '',
          'Only models that can write a Resume are returned: Anthropic lists nothing else,',
          "Google's entries are filtered on the `generateContent` capability they declare, and",
          "OpenAI's are filtered by excluding the families that cannot — embeddings, speech,",
          'images and moderation — so that a chat model released tomorrow still appears.',
          '',
          '`defaultModel` is what a picker should land on. It is not a promise that the list',
          'contains it.',
        ].join('\n'),
        requestBody: { required: true, ...json('ListModelsRequest') },
        responses: {
          '200': { description: 'The models this key can use.', ...json('AvailableModels') },
          '400': errorResponse('The body is invalid, or the platform rejected the API key.'),
          '429': errorResponse('Too many model lookups in the last minute.'),
          '502': errorResponse('The platform could not be reached.'),
          '503': errorResponse('No API key was supplied and none is configured for that platform.'),
          ...AUTH_ERRORS,
        },
      },
    },

    '/api/cover-letter/generate': {
      post: {
        tags: ['Cover letter'],
        summary: "Write the cover letter's content for one application",
        description: [
          'The step after the Resume. Sends the company, the job title, the job description',
          '**and the finished Resume** to the configured AI platform, and returns the letter it',
          'writes. Rendering that letter into a file is `/api/cover-letter/render`.',
          '',
          'The Resume travels in the body rather than being looked up, because at this point',
          'it usually does not exist on the server yet: on the application form it has not been',
          'saved, and on the JSON route it was pasted in rather than generated here. It is the',
          'document `/api/resume/generate` answered with, handed straight back.',
          '',
          '**A second call rather than a second field on the Resume\'s answer.** Asking for both',
          'at once would mean a letter that could not be rewritten without also rewriting the',
          'Resume it was approved alongside — and it is what lets the letter genuinely be',
          'written *from* the finished Resume, which is what the prompt asks for.',
          '',
          'Its own system prompt, edited separately from the Resume\'s on the AI Settings',
          'screen, and returned by neither this route nor any other. Nothing is stored; the',
          '`X-Resume-Provider` and `X-Resume-Model` response headers name what wrote it.',
        ].join('\n'),
        requestBody: { required: true, ...json('GenerateCoverLetterRequest') },
        responses: {
          '200': { description: "The cover letter's content.", ...json('GeneratedCoverLetter') },
          '429': errorResponse('Too many cover letters generated in the last minute.'),
          '502': errorResponse(
            'The AI platform failed, declined, or returned an unusable cover letter.',
          ),
          '503': errorResponse('No API key is configured for the selected AI provider.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/cover-letter/render': {
      post: {
        tags: ['Cover letter'],
        summary: 'Render a generated cover letter as PDF or Word',
        description: [
          'Lays the generated letter out in the cover letter template and returns the file.',
          '',
          'Separate from generation so that a second format costs nothing: the AI is paid for',
          'once and both files come from the one answer.',
          '',
          'The letter travels with the request; the name at the top, the contact line and the',
          'signature come from the signed-in account\'s profile and cannot be supplied by a',
          'client — nobody signs someone else\'s name to a letter through this API.',
          '',
          'The page is the Resume\'s: US Letter, Word\'s Narrow margins, Calibri bound to an',
          'embedded metric-compatible face. `pdf` is printed from the template\'s own',
          'stylesheet through headless Chromium, `docx` is built with the same measurements',
          "stated in Word's terms.",
        ].join('\n'),
        requestBody: { required: true, ...json('RenderCoverLetterRequest') },
        responses: {
          '200': {
            description: 'The cover letter file.',
            content: {
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          '429': errorResponse('Too many cover letters rendered in the last minute.'),
          '502': errorResponse('The PDF could not be printed. Word still works.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/profile': {
      get: {
        tags: ['Profile'],
        summary: 'The Resume profile',
        responses: {
          '200': { description: 'The profile.', ...json('Profile') },
          ...AUTH_ERRORS,
        },
      },
      put: {
        tags: ['Profile'],
        summary: 'Replace the Resume profile',
        description:
          'A full replace, not a merge — work history and education are rewritten in the ' +
          'order given.',
        requestBody: { required: true, ...json('ProfileInput') },
        responses: {
          '200': { description: 'The saved profile.', ...json('Profile') },
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/profile/photo': {
      post: {
        tags: ['Profile'],
        summary: 'Upload the candidate photo',
        description:
          'Multipart, one file in the `photo` field: JPEG, PNG, WebP or GIF, at most 5 MB. ' +
          'Replaces whatever photo is stored and deletes the old object. The whole profile ' +
          'comes back, with a freshly signed `photoUrl`.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['photo'],
                properties: { photo: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'The profile, with the new photo.', ...json('Profile') },
          '400': errorResponse('No file, an unsupported type, or larger than 5 MB.'),
          '404': errorResponse('This account has no profile.'),
          '503': errorResponse('No S3 bucket is configured for this deployment.'),
          ...AUTH_ERRORS,
        },
      },
      delete: {
        tags: ['Profile'],
        summary: 'Remove the candidate photo',
        description: 'Deleting a photo that is not there is not an error.',
        responses: {
          '200': { description: 'The profile, with no photo.', ...json('Profile') },
          '404': errorResponse('This account has no profile.'),
          ...AUTH_ERRORS,
        },
      },
    },

    '/api/admin/users': {
      get: {
        tags: ['Admin'],
        summary: 'Every account, with its profile summary',
        description:
          'What the profile switcher and the user list on the Profile screen read. ' +
          '`bidCount` is how many applications are filed under each account.',
        responses: {
          '200': { description: 'All accounts.', ...jsonArray('AdminUser') },
          '403': errorResponse('This action is restricted to administrators.'),
          ...AUTH_ERRORS,
        },
      },
      post: {
        tags: ['Admin'],
        summary: 'Create a User account',
        description:
          'Creates a platform User with credentials only (always role `user`). ' +
          'There is no public sign-up; the sole Admin is managed with `yarn admin`.',
        requestBody: { required: true, ...json('CreateUser') },
        responses: {
          '201': { description: 'The new account.', ...json('AdminUserDetail') },
          '409': errorResponse('That email is already registered.'),
          '403': errorResponse('This action is restricted to administrators.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/admin/users/{id}': {
      get: {
        tags: ['Admin'],
        summary: 'One account and its full profile',
        parameters: [userIdParam],
        responses: {
          '200': { description: 'The account.', ...json('AdminUserDetail') },
          '404': errorResponse('No such account.'),
          '403': errorResponse('This action is restricted to administrators.'),
          ...AUTH_ERRORS,
        },
      },
      patch: {
        tags: ['Admin'],
        summary: "Change an account's email or password",
        description:
          'Every field is optional; send only what changes. A new password also revokes that ' +
          "account's live refresh tokens. Role cannot be changed here — the deployment has one Admin.",
        parameters: [userIdParam],
        requestBody: { required: true, ...json('UpdateUser') },
        responses: {
          '200': { description: 'The updated account.', ...json('AdminUserDetail') },
          '400': errorResponse('Nothing to change.'),
          '404': errorResponse('No such account.'),
          '409': errorResponse('Another account already uses that email.'),
          '403': errorResponse('This action is restricted to administrators.'),
          ...AUTH_ERRORS,
        },
      },
      delete: {
        tags: ['Admin'],
        summary: 'Delete an account and everything it owns',
        description:
          'Cascades to bids, interviews, commitments, profile, settings and sessions. An admin ' +
          'cannot delete their own account.',
        parameters: [userIdParam],
        responses: {
          '204': { description: 'Deleted.' },
          '400': errorResponse('You cannot delete your own account.'),
          '404': errorResponse('No such account.'),
          '403': errorResponse('This action is restricted to administrators.'),
          ...AUTH_ERRORS,
        },
      },
    },

    '/api/admin/users/{id}/login-history': {
      get: {
        tags: ['Admin'],
        summary: 'Recent successful sign-ins for one account',
        description:
          'Newest first, capped at 50. Each row is a password login (`POST /api/auth/login`) with ' +
          'IP, GeoIP location (city / region / country, coordinates, ISP), and parsed client ' +
          '(browser, OS, device). Token refresh is not recorded.',
        parameters: [userIdParam],
        responses: {
          '200': { description: 'Login events.', ...jsonArray('LoginHistoryEntry') },
          '404': errorResponse('No such account.'),
          '403': errorResponse('This action is restricted to administrators.'),
          ...AUTH_ERRORS,
        },
      },
    },

    '/api/admin/users/{id}/profile': {
      put: {
        tags: ['Admin'],
        summary: "Replace another account's Resume profile",
        description:
          'The same full replace as `PUT /api/profile`, and the same service behind it — an ' +
          'admin editing a profile and its owner editing it are the same write.',
        parameters: [userIdParam],
        requestBody: { required: true, ...json('ProfileInput') },
        responses: {
          '200': { description: 'The saved profile.', ...json('Profile') },
          '403': errorResponse('This action is restricted to administrators.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/admin/users/{id}/profile/photo': {
      post: {
        tags: ['Admin'],
        summary: "Upload another account's candidate photo",
        parameters: [userIdParam],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['photo'],
                properties: { photo: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'The profile, with the new photo.', ...json('Profile') },
          '400': errorResponse('No file, an unsupported type, or larger than 5 MB.'),
          '503': errorResponse('No S3 bucket is configured for this deployment.'),
          '403': errorResponse('This action is restricted to administrators.'),
          ...AUTH_ERRORS,
        },
      },
      delete: {
        tags: ['Admin'],
        summary: "Remove another account's candidate photo",
        parameters: [userIdParam],
        responses: {
          '200': { description: 'The profile, with no photo.', ...json('Profile') },
          '403': errorResponse('This action is restricted to administrators.'),
          ...AUTH_ERRORS,
        },
      },
    },

    '/api/admin/users/{id}/ai-prompts': {
      get: {
        tags: ['Admin'],
        summary: "One account's AI prompts",
        description:
          'The per-profile half of AI settings: the Resume and cover letter prompts in force ' +
          "for this account — its own where one is set, otherwise the deployment's " +
          '(`GET /api/admin/ai`), otherwise the built-in default. `overrides` says which of ' +
          'the two is set for the account, and `defaults` is what clearing one reverts to. ' +
          'Admin-only, like the deployment\'s; there is no self-service route.',
        parameters: [userIdParam],
        responses: {
          '200': { description: 'The prompts.', ...json('UserAiPrompts') },
          '403': errorResponse('This action is restricted to administrators.'),
          '404': errorResponse('No such account.'),
          ...AUTH_ERRORS,
        },
      },
      put: {
        tags: ['Admin'],
        summary: "Change one account's AI prompts",
        description:
          'A partial update. An omitted field is left alone; an explicit `null` (or an empty ' +
          'string) drops that override and hands the prompt back to the deployment. The ' +
          'provider, model and key are not here — they stay deployment-wide.',
        parameters: [userIdParam],
        requestBody: { required: true, ...json('UserAiPromptsInput') },
        responses: {
          '200': { description: 'The prompts after the change.', ...json('UserAiPrompts') },
          '403': errorResponse('This action is restricted to administrators.'),
          '404': errorResponse('No such account.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/admin/ai': {
      get: {
        tags: ['Admin'],
        summary: 'The deployment-wide AI settings',
        description:
          'Provider, model and system prompt in force, plus where the API key comes from. The ' +
          'key itself is never returned — `hasApiKey` and `keySource` are all there is. ' +
          '`overrides` says which fields are stored here rather than coming from the ' +
          'environment, and `defaults` is what clearing one reverts to.',
        responses: {
          '200': { description: 'The settings.', ...json('AiSettings') },
          '403': errorResponse('This action is restricted to administrators.'),
          ...AUTH_ERRORS,
        },
      },
      put: {
        tags: ['Admin'],
        summary: 'Change the AI settings',
        description:
          'A partial update. An omitted field is left alone; an explicit `null` clears that ' +
          'override and hands the field back to the environment. `apiKey` is write-only: a ' +
          'string replaces the stored key, `null` deletes it.',
        requestBody: { required: true, ...json('AiSettingsInput') },
        responses: {
          '200': { description: 'The settings after the change.', ...json('AiSettings') },
          '403': errorResponse('This action is restricted to administrators.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/settings': {
      get: {
        tags: ['Settings'],
        summary: 'App settings',
        responses: {
          '200': { description: 'The settings.', ...json('AppSettings') },
          ...AUTH_ERRORS,
        },
      },
      put: {
        tags: ['Settings'],
        summary: 'Replace app settings',
        requestBody: { required: true, ...json('AppSettings') },
        responses: {
          '200': { description: 'The saved settings.', ...json('AppSettings') },
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/dashboard': {
      get: {
        tags: ['Dashboard'],
        summary: 'Every aggregate the Dashboard screen needs, in one request',
        parameters: queryParams(DashboardQuerySchema),
        responses: {
          '200': { description: 'The summary.', ...json('Dashboard') },
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/data/export': {
      get: {
        tags: ['Data'],
        summary: 'Export the whole account',
        description: "Same JSON shape as the frontend's own `remote-ops-backup.json`.",
        responses: {
          '200': { description: 'The full dataset.', ...json('DataBundle') },
          ...AUTH_ERRORS,
        },
      },
    },

    '/api/data/import': {
      post: {
        tags: ['Data'],
        summary: 'Restore an exported backup',
        parameters: [
          {
            name: 'mode',
            in: 'query',
            schema: { type: 'string', enum: ['merge', 'replace'], default: 'merge' },
            description: '`replace` deletes existing bids first; `merge` adds alongside them.',
          },
        ],
        requestBody: { required: true, ...json('ImportBundle') },
        responses: {
          '200': { description: 'What was imported.', ...json('ImportResult') },
          '422': errorResponse('A bid in the bundle violates a business rule.'),
          ...COMMON_ERRORS,
        },
      },
    },

    '/api/data': {
      delete: {
        tags: ['Data'],
        summary: 'Delete all bids and reset the profile and settings',
        description: 'The account itself survives. This is "Clear All Data", server-side.',
        responses: {
          '200': {
            description: 'How many bids were deleted.',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { bidsDeleted: { type: 'integer' } } },
              },
            },
          },
          ...AUTH_ERRORS,
        },
      },
    },
  },
} as const;
