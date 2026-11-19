/**
 * The wire contract. These are a deliberate, exact mirror of the frontend's
 * `src/lib/types.ts` — the API returns these shapes verbatim so that swapping
 * the frontend's `storage.ts` for an HTTP client is a change to that one file
 * and nothing else.
 *
 * Keep this file and the frontend's copy in lockstep.
 */

export type BidStatus =
  | 'Draft'
  | 'Applied'
  | 'Screening (Round 1)'
  | 'Interview (Round 2)'
  | 'Interview (Round 3)'
  | 'Final Interview'
  | 'Offer'
  | 'Background Check Passed'
  | 'Started'
  | 'Completed'
  | 'Failed'
  | 'Expired'
  | 'Other'
  | 'Skip';

export const BID_STATUSES = [
  'Draft',
  'Applied',
  'Screening (Round 1)',
  'Interview (Round 2)',
  'Interview (Round 3)',
  'Final Interview',
  'Offer',
  'Background Check Passed',
  'Started',
  'Completed',
  'Failed',
  'Expired',
  'Other',
  'Skip',
] as const satisfies readonly BidStatus[];

/** Statuses that cannot be entered without a scheduled date and time. */
export const INTERVIEW_STAGES = [
  'Screening (Round 1)',
  'Interview (Round 2)',
  'Interview (Round 3)',
  'Final Interview',
] as const satisfies readonly BidStatus[];

export type InterviewStage = (typeof INTERVIEW_STAGES)[number];

/** Statuses that make a bid a commitment. */
export const COMMITMENT_STATUSES = ['Started', 'Completed'] as const satisfies readonly BidStatus[];

export function isInterviewStage(status: BidStatus): status is InterviewStage {
  return (INTERVIEW_STAGES as readonly BidStatus[]).includes(status);
}

export function isCommitmentStatus(status: BidStatus): boolean {
  return (COMMITMENT_STATUSES as readonly BidStatus[]).includes(status);
}

export type RateType = 'hourly' | 'annually';

export interface CommitmentDetails {
  startDate: string;
  endDate?: string;
  contractType: string;
  agreedRate: number;
}

export interface InterviewRound {
  stage: BidStatus;
  dateTime: string;
}

/**
 * Who an application is filed under, carried on every bid.
 *
 * Present because an admin's list spans every profile, so the owner can no
 * longer be inferred from "whoever is signed in". A plain account gets it too,
 * where it is always themselves — one shape for one table beats a column that
 * means two different things depending on who is reading it.
 */
/**
 * Another of the same profile's applications whose proof screenshot is the
 * same picture as this one's — judged by the pixels (see
 * `src/proof/fingerprint.ts`), not by the file.
 */
export interface ProofMatch {
  /**
   * Why the two screenshots count as one. `identical`: the same pixels, once
   * margin, container and metadata are set aside. Otherwise the same picture
   * through a lossy encoder, and `difference` is how far apart the worst cell
   * of their colour grids is — 0 for identical, 1 for black against white.
   */
  match: { identical: boolean; difference: number };
  /** The application carrying the other screenshot. */
  bid: Bid;
}

export interface BidCandidate {
  userId: string;
  /** Application Profile id when the bid is scoped to one; omitted on legacy rows. */
  profileId?: string;
  firstName: string;
  lastName: string;
  /** `"First Last"`, falling back to the account's email. */
  displayName: string;
  photoUrl?: string;
}

/** The step types the Pipeline drawer offers, in the order it offers them. */
export const INTERVIEW_STEP_TYPES = [
  'Recruiter Screen',
  'Hiring Manager',
  'Technical',
  'System Design',
  'Coding',
  'Behavioral',
  'Onsite',
  'Final',
  'Offer Discussion',
] as const;

export interface InterviewStepFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

/** One step of an application's interview process. See `InterviewStep` in the schema. */
export interface InterviewStep {
  id: string;
  type: string;
  companyName: string;
  /** `YYYY-MM-DDTHH:mm:ss`, wall-clock in `timezone`; absent while "TBD". */
  scheduledAt?: string;
  timezone?: string;
  durationMinutes?: number;
  details: string;
  position: number;
  files: InterviewStepFile[];
  createdAt: string;
}

/** The two files the desktop Resume Builder writes for one application. */
export type ResumeFileFormat = 'pdf' | 'docx';

/** One synced Resume file as the list describes it: its name and hash, not its bytes. */
export interface ResumeFileInfo {
  /** The file's own name on disk, e.g. `William_Kolega_Acme_resume.pdf`. */
  name: string;
  size: number;
  /** Hex SHA-256 of the bytes, for the folder sync's unchanged check. */
  sha256: string;
  /** When this file was last uploaded (ISO instant). */
  updatedAt: string;
}

export interface Bid {
  id: string;
  /**
   * The application's number within its filing scope (its Profile, or its
   * owner's legacy rows): 1 for the first one filed, counting up. The "#"
   * column of the Applications table. Server-assigned; never reused.
   */
  number: number;
  company: string;
  role: string;
  jobUrl?: string;
  location: string;
  jobDescription?: string;
  /** When the job board says the posting went up (ISO instant), if known. */
  postedAt?: string;
  rateType?: RateType;
  rateAmount?: number;
  bidDate: string;
  status: BidStatus;
  followUpDate?: string;
  resumeVersion?: string;
  /**
   * Whether a generated Resume is stored for this bid, and so whether it can be
   * downloaded. The document itself is deliberately not on the wire here: every
   * screen loads the whole bid list, and carrying a few kilobytes of Resume per
   * row would make every one of them pay for a file almost none of them show.
   */
  hasResume?: boolean;
  /**
   * A short hash of everything that shapes the Resume file — the stored
   * document, the profile's template and the candidate's name. It changes
   * whenever a download would come out different, which is what lets a folder
   * sync rewrite a changed Resume rather than skip it as already downloaded.
   */
  resumeFingerprint?: string;
  /**
   * The Resume files synced up from the desktop Resume Builder's folder, by
   * format — what is there and its hash, never the bytes. The folder sync
   * compares `sha256` against the file on disk so an unchanged file is not
   * uploaded again; `GET /api/bids/:id/resume?format=` serves the bytes.
   * Absent when no file was synced; `hasResume` is then down to the stored
   * document alone.
   */
  resumeFiles?: Partial<Record<ResumeFileFormat, ResumeFileInfo>>;
  /**
   * Whether a cover letter is stored for this bid, on exactly the terms
   * `hasResume` is: the flag travels, the document does not, and
   * `GET /api/bids/:id/cover-letter` has the file.
   */
  hasCoverLetter?: boolean;
  /**
   * How many turns the conversation about this application ran to — the count,
   * not the transcript. Same reasoning as `hasResume`: the list is loaded whole
   * by every screen, and a conversation per row would be paid for by all of
   * them to be read by almost none. `GET /api/bids/:id/chat` has the text.
   */
  chatMessageCount?: number;
  notes?: string;
  /**
   * A short-lived signed URL to the screenshot of the job site's confirmation
   * page, uploaded when the application was filed — the evidence an admin
   * checks that a job was really applied to. Absent when none was uploaded,
   * and on every application filed before this existed.
   */
  proofUrl?: string;
  commitmentDetails?: CommitmentDetails;
  interviews?: InterviewRound[];
  /** The interview steps, in order. Always present (possibly empty) on a read. */
  steps?: InterviewStep[];
  /** When the application was archived from the Pipeline board; absent while active. */
  archivedAt?: string;
  /** When the application was first sent (moved past Draft); absent while a Draft. */
  appliedAt?: string;
  /** When its Resume was first stored; absent while it has none. */
  resumeMadeAt?: string;
  candidate?: BidCandidate;
  createdAt: string;
  updatedAt: string;
}

/**
 * The orderings the list endpoint offers. `bidDate` and `updatedAt` are newest
 * first; `number` is the order the applications were filed in, first to last.
 */
export type BidSort = 'bidDate' | 'updatedAt' | 'number';

/**
 * One page of the list, for the screens that no longer load it whole.
 *
 * `total` is the count across every page under the same filters, which is what
 * a table needs to say "showing 26–50 of 312" and to know when to stop paging.
 */
export interface BidPage {
  items: Bid[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * One column of the Pipeline board: how many applications sit at this status,
 * and the first page of them. The rest are fetched a page at a time through
 * the list endpoint as the column is scrolled.
 */
export interface PipelineStage {
  status: BidStatus;
  total: number;
  items: Bid[];
}

export interface PipelineBoard {
  /** How many cards each stage carries at most, so the client knows where page 2 starts. */
  pageSize: number;
  /** Every status, in funnel order, including the ones with no applications. */
  stages: PipelineStage[];
}

export interface WorkExperience {
  id: string;
  company: string;
  title: string;
  location: string;
  startDate: string;
  endDate: string | null;
}

export interface Education {
  id: string;
  degree: string;
  major: string;
  university: string;
  location: string;
  /** `YYYY-MM-DD`, or `''` when not filled in. */
  startDate: string;
  /** `null` while the degree is still in progress. */
  endDate: string | null;
}

export interface Profile {
  firstName: string;
  middleName: string;
  lastName: string;
  hasPreferredName: boolean;
  preferredFirstName: string;
  preferredLastName: string;
  dateOfBirth: string;
  resumeTemplateId: string;
  location: string;
  addressLine: string;
  city: string;
  state: string;
  zipCode: string;
  county: string;
  country: string;
  timezone: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  otherUrl: string;
  email: string;
  phone: string;
  authorizedCountries: string[];
  gender: string;
  ethnicity: string;
  disabilityStatus: string;
  veteranStatus: string;
  lgbtqIdentity: string;
  birthYear: string;
  securityClearance: string;
  drugTestWillingness: string;
  noticePeriod: string;
  openToRelocation: string;
  inPersonAvailability: string;
  requireAccommodations: string;
  /**
   * A short-lived signed URL for the candidate's photo, absent when none has
   * been uploaded or when this deployment has no bucket configured. Read-only:
   * `PUT /api/profile` neither expects nor accepts it, because the photo is
   * changed by uploading one, not by saving the form.
   */
  photoUrl?: string;
  workExperience: WorkExperience[];
  education: Education[];
}

export interface AppSettings {
  dailyBidGoal: number;
  theme: 'light' | 'dark';
}

/** The `/api/data/export` payload — and what `/api/data/import` accepts back. */
export interface DataBundle {
  bids: Bid[];
  profile: Profile;
  settings: AppSettings;
}
