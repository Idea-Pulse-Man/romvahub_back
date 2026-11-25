/**
 * A short Resume prompt that tailors the Profile's own work history to each
 * posting: paste it into Profiles → Prompts & Template → Resume prompt.
 *
 * `{{CANDIDATE}}` is replaced by the Profile's jobs (title, company, place,
 * dates), years of experience and education, read from the Profile itself,
 * so none of it is typed into the prompt twice. After the prompt, the request
 * carries the posting and the answer's JSON shape, sized to the Profile's Word
 * template (make-steps.ts `historyRequest`). The job titles, employers and
 * places in the finished Resume are the Profile's, never the AI's.
 *
 * The notes at the end are optional: what the person actually did at each
 * job (tools, projects), so the bullet points describe their own work.
 */
export const PROFILE_HISTORY_RESUME_PROMPT = `Tailor my work history below into an ATS-friendly Resume for this job.

{{CANDIDATE}}

Rules:
- Summary: one paragraph, 3 sentences, 35-45 words: my current title and years of experience; my strongest skills for this job; how I work with teams.
- Skills: Title Case group names, "&" instead of "and"; 4-5 comma-separated skills per group, most relevant first; only skills that fit my jobs.
- Bullets: one sentence each, 20-25 words, starting with a strong verb (present tense for a current job), ending with a period. Cover different work in each job, using the posting's keywords where they fit my work.
- No invented numbers, percentages, team sizes or results.
- Write "%" not "percent", digits not number words (except first, second...), and "-" never "—" or "~".
- Finished text only: no placeholders, brackets or notes.

Notes on what I did at each job (optional; when a job has notes, its bullets stay within them):
`;
