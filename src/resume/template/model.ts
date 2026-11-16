import type { Education, Profile, WorkExperience } from '../../domain/types.js';
import type { ResumePayload } from '../resume.schemas.js';

/**
 * Turns the user's profile and the AI's payload into the Resume's content, with
 * no regard for how it will be presented.
 *
 * Both output formats — `html.ts` (HTML → PDF) and `docx.ts` (.docx) — render
 * this same model, so the two files can never disagree about what the Resume
 * says. Only the styling of each lives in its own module.
 *
 * Ported from the resume-builder desktop app's `src/resumeModel.js`, which is
 * the definition of this template. Its Settings become this app's Profile:
 *
 *   Profile   name, contact line, employers (company / location / dates), education
 *   Payload   summary, skills, role titles, bullets
 *
 * The split is by what varies. The profile holds the facts that are the same on
 * every application — and is deliberately *not* sent to the AI; the payload
 * holds what is tailored per job. Nothing is sourced from both, so there is no
 * precedence to reason about.
 *
 * Every string the payload supplies — the summary, the skills, the role
 * titles, the bullets — may be written in Markdown, and both renderers print
 * its emphasis rather than its markers (`inline.ts`). The profile's own fields
 * are typed into a form and are printed as they were typed.
 *
 * Section order: Header → Summary → Skills → Work Experience → Education —
 * the order a Resume conventionally uses, which is what an applicant tracking
 * system is built to read. The renderers decide it; this module only supplies
 * the parts.
 */

/** Dates print as "Jul 2025", so only the three-letter abbreviations are needed. */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "2025-07" (or "2025-07-15") → "Jul 2025". */
export function formatMonthYear(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})/.exec(value);
  if (!match) return value;

  const year = match[1]!;
  const monthIndex = Number.parseInt(match[2]!, 10) - 1;
  if (monthIndex < 0 || monthIndex > 11) return year;

  return `${MONTHS[monthIndex]} ${year}`;
}

/**
 * Join a start/end pair into "Jul 2025 - Aug 2026" style, dropping empties.
 * Work Experience and Education print dates identically. A null end date is a
 * role still held, which prints as "Present".
 */
export function dateRange(start?: string | null, end?: string | null): string {
  const from = formatMonthYear(start);
  const to = end ? formatMonthYear(end) : 'Present';
  if (from && to) return `${from} - ${to}`;
  return from || to || '';
}

/**
 * A field that prints as one or more lines, given as either an array of lines or
 * a single newline-delimited string. Blank entries are dropped, so a trailing
 * newline or an empty array slot is harmless rather than an empty paragraph.
 */
function toLines(value: string | string[] | null | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];

  return raw
    .filter((entry): entry is string => entry != null)
    // An array entry may itself contain newlines; treat those as line breaks too.
    .flatMap((entry) => String(entry).split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * "Bachelor of Science" + "Computer Science" → "Bachelor of Science in Computer
 * Science". A degree field that already names the major is left alone, so either
 * data entry style produces the same single line.
 */
export function degreeLine(degree?: string, major?: string): string {
  const d = (degree || '').trim();
  const m = (major || '').trim();
  if (!d) return m;
  if (!m) return d;
  if (d.toLowerCase().includes(m.toLowerCase())) return d;
  return `${d} in ${m}`;
}

export interface JobBlock {
  /** The role, which the renderers print with the dates against the right margin. */
  title: string;
  /** The employer, printed with the location against the right margin. */
  company: string;
  location: string;
  /** "Aug 2024 - Present". */
  dates: string;
  bullets: string[];
}

export interface EducationBlock {
  degree: string;
  /** "University of Texas - Austin, TX", printed with the dates against the right margin. */
  school: string;
  dates: string;
}

/**
 * The Resume's content. Every string is plain text — escaping is the HTML
 * renderer's business, not this module's.
 *
 * `summary` / `skills` / `jobs` are empty arrays and `education` is null when
 * the section should not be printed at all.
 */
export interface ResumeModel {
  name: string;
  /** Location, email and phone — pipe-joined onto one line. */
  personal: string[];
  summary: string[];
  /** One line each, as written — `Languages: Go, Python`. The renderers print the category bold. */
  skills: string[];
  jobs: JobBlock[];
  education: EducationBlock | null;
}

export function buildResumeModel(profile: Profile, payload: ResumePayload): ResumeModel {
  const experience: WorkExperience[] = profile.workExperience ?? [];
  const education: Education | undefined = profile.education?.[0];

  // ---- Header ----
  // Who you are is the one part of the Resume that does not change per
  // application, so it comes from the profile only — the AI has no say in it,
  // and is never shown it.
  const name = `${profile.firstName || ''} ${profile.lastName || ''}`.trim();
  const personal = [profile.location, profile.email, profile.phone].filter(Boolean);

  // ---- Work Experience ----
  // One block per group of bullets, in the order the AI returned them, paired
  // positionally with the profile's employers: the prompt asks for the groups
  // newest-first, which is the order the employers are held in.
  const jobs: JobBlock[] = payload.bullets.map((group, index) => {
    const employer = experience[index];
    const bullets = (Array.isArray(group) ? group : [group])
      .filter((bullet) => bullet && String(bullet).trim())
      .map((bullet) => String(bullet).trim());

    return {
      title: payload.roleTitles[index] || '',
      company: employer?.company?.trim() || '',
      location: employer?.location?.trim() || '',
      dates: employer ? dateRange(employer.startDate, employer.endDate) : '',
      bullets,
    };
  });

  // ---- Education ----
  const educationBlock: EducationBlock | null = education
    ? {
        degree: degreeLine(education.degree, education.major),
        // "University - Location" is one field, not two: the dates are what
        // goes against the right margin beside it.
        school: [education.university, education.location].filter(Boolean).join(' - '),
        dates: dateRange(education.startDate, education.endDate),
      }
    : null;

  return {
    name: name || 'Your Name',
    personal,
    summary: toLines(payload.summary),
    skills: toLines(payload.skills),
    jobs,
    education: educationBlock,
  };
}
