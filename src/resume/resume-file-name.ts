/**
 * What a document is called when it leaves the app.
 *
 *   Andrew Zhu.pdf
 *   Andrew Zhu.docx
 *
 * The candidate's name and nothing else. A recruiter's inbox and a hiring
 * folder are full of files from different people, so the name that identifies
 * one is whose it is; the company and the role were the recruiter's own — they
 * already know which opening they are filling — and only made the file longer.
 * The Resume and the letter are named alike for the same reason: it is one
 * candidate's application either way, and which document it is, is plain from
 * opening it.
 *
 * One rule for all four exits — the browser download from the application form,
 * the download from the applications table, the `Content-Disposition` on the
 * rendered and stored routes — so the file a recruiter receives has the same
 * name however it got there. The frontend carries a matching copy in
 * `src/lib/resume-file.ts`; the two are meant to be read together.
 */

/**
 * Characters a filename cannot safely carry on any of the systems one of these
 * files lands on. `/` and `\` would be read as path separators and the rest are
 * what Windows refuses outright — a Resume is downloaded onto real machines, so
 * the name has to survive one.
 */
const UNSAFE = /[/\\?%*:|"<>#]+/g;

function clean(value: string): string {
  return (
    value
      .replace(UNSAFE, ' ')
      // Collapsed after the substitution, so `A / B` does not leave a double gap.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function resumeFileName(options: {
  firstName: string;
  lastName: string;
  extension: string;
  /**
   * What the file is called when the profile has no name yet — `firstName` and
   * `lastName` are both blank on a freshly registered account, and a file
   * called `.pdf` is one the browser saves happily and nobody finds again.
   */
  fallback?: string;
}): string {
  const stem =
    // The trailing trim is on the joined stem rather than on each half,
    // because what Windows objects to is a name that *ends* in a dot or a
    // space — `St. John` in the middle of one is just how a name is written.
    [clean(options.firstName), clean(options.lastName)].filter(Boolean).join(' ').replace(/[. ]+$/, '') ||
    clean(options.fallback || '') ||
    'resume';

  return `${stem}.${options.extension}`;
}
