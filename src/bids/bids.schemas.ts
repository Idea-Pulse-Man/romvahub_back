import { z } from 'zod';
import { isDateOnly, isNaiveDateTime } from '../domain/dates.js';
import { BID_STATUSES, INTERVIEW_STAGES } from '../domain/types.js';
import { RESUME_FORMATS, ResumePayloadSchema } from '../resume/resume.schemas.js';
import { CoverLetterPayloadSchema } from '../cover-letter/cover-letter.schemas.js';
import { ChatTranscriptSchema } from '../questions/questions.schemas.js';

export const dateOnly = z
  .string()
  .refine(isDateOnly, 'Must be a calendar date in YYYY-MM-DD form.');

export const naiveDateTime = z
  .string()
  .refine(isNaiveDateTime, 'Must be a date and time in YYYY-MM-DDTHH:mm:ss form.');

export const BidStatusSchema = z.enum(BID_STATUSES);
export const InterviewStageSchema = z.enum(INTERVIEW_STAGES);
export const RateTypeSchema = z.enum(['hourly', 'annually']);

/**
 * The frontend's form initialises optional text fields to `''` rather than
 * leaving them undefined, so an empty string has to mean "not set" rather than
 * failing a URL or date check.
 */
function blankable<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
}

export const InterviewRoundSchema = z.object({
  stage: InterviewStageSchema,
  dateTime: naiveDateTime,
});

export const CommitmentDetailsSchema = z.object({
  startDate: dateOnly,
  endDate: blankable(dateOnly),
  contractType: z.string().trim().min(1, 'Contract type is required.').max(100),
  agreedRate: z.number().nonnegative().max(10_000_000),
});

const money = z.number().nonnegative().max(10_000_000);

export const CreateBidSchema = z.object({
  company: z.string().trim().min(1, 'Company is required.').max(200),
  role: z.string().trim().min(1, 'Role is required.').max(200),
  jobUrl: blankable(z.url('Must be a valid URL.').max(2048)),
  location: z.string().trim().max(200).default(''),
  jobDescription: blankable(z.string().max(50_000)),
  /**
   * When the job board says the posting went up — an ISO-8601 instant. Sent by
   * the scraper; a Draft more than 2 days past it is expired each morning.
   */
  postedAt: blankable(z.iso.datetime({ offset: true })),
  rateType: blankable(RateTypeSchema),
  rateAmount: money.optional(),
  bidDate: dateOnly,
  status: BidStatusSchema.default('Draft'),
  followUpDate: blankable(dateOnly),
  resumeVersion: blankable(z.string().max(200)),
  notes: blankable(z.string().max(20_000)),
  interviews: z.array(InterviewRoundSchema).max(INTERVIEW_STAGES.length).optional(),
  commitmentDetails: CommitmentDetailsSchema.optional(),
  /**
   * The Resume generated for this application, stored so it can be downloaded
   * again later. `null` clears it; omitting the key leaves it untouched.
   */
  resumeDocument: ResumePayloadSchema.nullish(),
  /**
   * The cover letter written for this application, stored on the same terms as
   * the Resume: `null` clears it, and omitting the key leaves it untouched. An
   * optional step, so most applications have none.
   */
  coverLetterDocument: CoverLetterPayloadSchema.nullish(),
  /**
   * The conversation held while filling in this application's form.
   * `null` or `[]` clears it; omitting the key leaves it untouched — which
   * matters because the edit form submits the whole bid back, and a screen that
   * never loaded the transcript must not be able to wipe it by saying nothing.
   */
  applicationChat: ChatTranscriptSchema.nullish(),
  /**
   * Which account to file this application under.
   *
   * Only an administrator may set it — they choose the profile on the form.
   * Anyone else gets their own account whatever they send, so this is ignored
   * rather than rejected: it is not a field a plain client has any reason to
   * know about, and refusing a request over it would only be confusing.
   */
  userId: z.uuid('Not a valid account id.').optional(),
  /**
   * Which application Profile this bid belongs to.
   *
   * Only an administrator may set it — it is what the logo switcher scopes
   * Dashboard / Applications / Pipeline by. Plain accounts ignore it and keep
   * filing under their own login.
   */
  profileId: z.uuid('Not a valid profile id.').optional(),
});

/**
 * Every field optional. Unknown keys are stripped rather than rejected, because
 * the frontend's edit form submits the whole bid back — `id`, `createdAt` and
 * `updatedAt` included — and those are server-owned.
 *
 * `commitmentDetails: null` explicitly clears the commitment; omitting the key
 * leaves it untouched.
 */
/**
 * A partial update — genuinely partial.
 *
 * `.partial()` makes a field optional but keeps its `.default()`, so `status`
 * and `location` arrived on every PATCH whether or not the client sent them:
 * `PATCH { notes }` parsed to `{ notes, status: 'Draft', location: '' }` and
 * quietly reset both. The frontend always submits the whole bid, which is why
 * nothing noticed. Overriding the two defaulted fields with plain optionals is
 * what makes an absent field absent.
 */
export const UpdateBidSchema = CreateBidSchema.partial().extend({
  commitmentDetails: CommitmentDetailsSchema.nullish(),
  /** Archive (true) or restore (false) the application on the Pipeline board. */
  archived: z.boolean().optional(),
  location: z.string().trim().max(200).optional(),
  status: BidStatusSchema.optional(),
});

export const BulkStatusSchema = z.object({
  ids: z.array(z.uuid()).min(1, 'At least one id is required.').max(500),
  status: BidStatusSchema,
  /**
   * Required when `status` is an interview stage — one time applied to every
   * selected bid, matching the frontend's bulk-schedule dialog.
   */
  interviewDateTime: naiveDateTime.optional(),
});

export const BulkDeleteSchema = z.object({
  ids: z.array(z.uuid()).min(1, 'At least one id is required.').max(500),
});

export const BidIdParamsSchema = z.object({
  id: z.uuid('Not a valid bid id.'),
});

/** `?format=pdf` on the Resume and cover letter downloads. */
export const BidResumeQuerySchema = z.object({
  format: z.enum(RESUME_FORMATS).default('pdf'),
});

export const BID_SORTS = ['bidDate', 'updatedAt', 'number'] as const;
export const BidSortSchema = z.enum(BID_SORTS);

/**
 * The most rows one request hands back once a client is paging. Large enough
 * that a table's "100 per page" is honoured, small enough that no single
 * response carries a whole career's worth of applications.
 */
export const MAX_PAGE_SIZE = 100;
/** What the Applications table shows when it does not say. */
export const DEFAULT_PAGE_SIZE = 25;
/** How many cards a Pipeline column opens with when it does not say. */
export const DEFAULT_STAGE_PAGE_SIZE = 10;

// Query strings arrive as text, so both are coerced. An absent value is left
// absent: `optional()` short-circuits before the coercion sees `undefined`.
const pageNumber = z.coerce.number().int().min(1, 'Pages start at 1.');
const pageSize = z.coerce
  .number()
  .int()
  .min(1, 'A page holds at least one row.')
  .max(MAX_PAGE_SIZE, `A page holds at most ${MAX_PAGE_SIZE} rows.`);

/**
 * Server-side equivalents of the Applications page's search and filters, plus
 * paging.
 *
 * `page` and `pageSize` are both optional so the endpoint keeps answering with
 * the whole list for the screens that need it — the Dashboard, the Calendar and
 * the Commitments page each derive their view from every application. Sending
 * either switches the response to a `BidPage`.
 */
export const ListBidsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional().describe(
    'The whole company name, matched as the same employer: case, punctuation, a leading "The" and ' +
      'a trailing legal form ("Inc", "LLC", …) are ignored. What the application form asks ' +
      'after reading a posting: has anyone in scope already applied here?',
  ),
  jobUrl: z.string().trim().max(2000).optional().describe(
    'The same posting by link: case, a #fragment, utm_* parameters and a trailing slash are ignored. ' +
      'What the Jobright / HiringCafe extension asks before saving: is this posting already an application?',
  ),
  status: BidStatusSchema.optional(),
  statuses: z
    .string()
    .trim()
    .max(500)
    .transform((value) => value.split(',').map((status) => status.trim()).filter(Boolean))
    .pipe(z.array(BidStatusSchema).max(BID_STATUSES.length))
    .optional()
    .describe(
      'Several statuses, comma-separated — any of them matches: `Failed,Skip,Expired,Other`. ' +
        'The Applications table\'s grouped filter (Draft, Applied, Progress, Failed).',
    ),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  /**
   * Admin only: restrict the list to one application Profile (logo switcher).
   * Ignored for plain accounts, who already see only their own rows.
   */
  profileId: z.uuid().optional(),
  hasResume: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
    .describe(
      'Only applications that have a Resume (`true`) or have none yet (`false`). With `status=Draft`: ' +
        'the desktop app\'s "Ready to apply" and "Draft" tabs.',
    ),
  needsRemake: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
    .describe('Only applications whose Resume check flagged them (`true`): the desktop app Needs remake tab.'),
  sort: BidSortSchema.optional().describe(
    'Ordering. `bidDate` (the default) is newest first; `updatedAt` is the Pipeline board\'s, so a ' +
      'card just moved sits at the top of its column; `number` is the Applications table\'s: the ' +
      'order the applications were filed in, #1 first.',
  ),
  page: pageNumber.optional().describe('1-based. Sending it, or `pageSize`, answers with a page rather than the whole list.'),
  pageSize: pageSize.optional().describe(`Rows per page, 1–${MAX_PAGE_SIZE}. Defaults to ${DEFAULT_PAGE_SIZE} when paging.`),
});

/**
 * The fields beside the file on `POST /api/bids/proof/check`: the application
 * being edited, whose own screenshot is not a duplicate of itself, and — for
 * an admin — the candidate the application is being filed for.
 */
export const ProofCheckSchema = z.object({
  bidId: z.uuid().optional(),
  userId: z.uuid().optional(),
});

/** `?pageSize=` on the Pipeline board: how many cards each column opens with. */
/** `GET /api/bids/version`: the same Profile scope as the list. */
export const BidsVersionQuerySchema = z.object({
  profileId: z.uuid().optional(),
});
export type BidsVersionQuery = z.infer<typeof BidsVersionQuerySchema>;

export const PipelineQuerySchema = z.object({
  pageSize: pageSize
    .default(DEFAULT_STAGE_PAGE_SIZE)
    .describe(`Cards per column in the first page, 1–${MAX_PAGE_SIZE}.`),
  /** Admin only: same Profile scope as the applications list / logo switcher. */
  profileId: z.uuid().optional(),
});

export type CreateBidInput = z.infer<typeof CreateBidSchema>;
export type UpdateBidInput = z.infer<typeof UpdateBidSchema>;
export type BulkStatusInput = z.infer<typeof BulkStatusSchema>;
export type BulkDeleteInput = z.infer<typeof BulkDeleteSchema>;
export type BidIdParams = z.infer<typeof BidIdParamsSchema>;
export type ListBidsQuery = z.infer<typeof ListBidsQuerySchema>;
export type PipelineQuery = z.infer<typeof PipelineQuerySchema>;
export type ProofCheckInput = z.infer<typeof ProofCheckSchema>;
export type BidResumeQuery = z.infer<typeof BidResumeQuerySchema>;
