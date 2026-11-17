/**
 * The "current company" and "current title" typed into application forms.
 *
 * They must say what the Resume attached to the same form says, so they come
 * from that application's own Resume: its top job. The Resume template puts
 * the Profile's work history in the order it is held (index 0 at the top,
 * under the title written for this role, `roleTitles[0]`), or the Resume's
 * own `companies` when it carries them (pasted Resume Maker JSON).
 *
 * Without a Resume (or one missing those fields), the Profile's top job.
 */

interface WorkEntry {
  company?: string | null;
  title?: string | null;
}

interface ResumeLike {
  roleTitles?: unknown;
  companies?: unknown;
}

const firstText = (list: unknown): string => {
  if (!Array.isArray(list)) return '';
  const value = list[0];
  return typeof value === 'string' ? value.trim() : '';
};

export function currentJob(
  workExperience: readonly WorkEntry[] | null | undefined,
  resumeDocument: unknown,
): { company: string; title: string } {
  const top = workExperience?.[0];
  const resume = resumeDocument && typeof resumeDocument === 'object' ? (resumeDocument as ResumeLike) : null;
  return {
    company: firstText(resume?.companies) || top?.company?.trim() || '',
    title: firstText(resume?.roleTitles) || top?.title?.trim() || '',
  };
}
