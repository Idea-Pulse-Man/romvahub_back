/**
 * Convert RemoteOps ResumePayload-shaped JSON into Maker flat merge JSON.
 */

export type StructuredResumeInput = {
  company: string;
  role: string;
  roleTitles: string[];
  summary: string;
  skills: string[];
  bullets: string[][];
  /** Employer per role, aligned with `roleTitles` — the template's `<Company-N>`. */
  companies?: string[];
  /** Optional display name from the candidate profile. */
  name?: string;
  /** Optional job posting text for meta / export naming. */
  jobDescription?: string;
};

export type MakerFlatJson = Record<string, unknown>;

/**
 * Parse a skills line like `Languages: Go | Python` into category + value.
 * Lines without a colon stay as whole-line core-skills entries only.
 */
function parseSkillLine(line: string): { category: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const colon = trimmed.indexOf(':');
  if (colon <= 0) {
    return null;
  }
  const category = trimmed.slice(0, colon).trim();
  const value = trimmed.slice(colon + 1).trim();
  if (!category) {
    return null;
  }
  return { category, value };
}

/**
 * Flatten structured RemoteOps resume payload into Maker mail-merge JSON.
 *
 * Produces `Role-title-N`, `Role-Bullet-N-M`, `Summary`, `resume-title`,
 * `technicalskills` (object) and `core-skills` (multiline), plus
 * `name` / `target_company` / `target_role` when available.
 */
export function structuredToFlat(input: StructuredResumeInput): MakerFlatJson {
  const flat: MakerFlatJson = {
    Summary: input.summary ?? '',
    summary: input.summary ?? '',
    'resume-title': input.role ?? '',
    resume_title: input.role ?? '',
    title: input.role ?? '',
    Title: input.role ?? '',
    target_company: input.company ?? '',
    target_role: input.role ?? '',
  };

  if (input.name?.trim()) {
    flat.name = input.name.trim();
    flat.Name = input.name.trim();
  }

  if (input.jobDescription !== undefined) {
    flat.job_description = input.jobDescription;
  }

  const roleTitles = input.roleTitles ?? [];
  for (let i = 0; i < roleTitles.length; i += 1) {
    const title = roleTitles[i] ?? '';
    // Both casings: Maker JSON samples vary; merge lookup is case-insensitive.
    flat[`Role-Title-${i + 1}`] = title;
    flat[`Role-title-${i + 1}`] = title;
  }

  const companies = input.companies ?? [];
  for (let i = 0; i < companies.length; i += 1) {
    flat[`Company-${i + 1}`] = companies[i] ?? '';
  }

  const bullets = input.bullets ?? [];
  for (let i = 0; i < bullets.length; i += 1) {
    const group = bullets[i] ?? [];
    for (let j = 0; j < group.length; j += 1) {
      flat[`Role-Bullet-${i + 1}-${j + 1}`] = group[j] ?? '';
    }
  }

  const skills = input.skills ?? [];
  const technicalskills: Record<string, string> = {};
  const coreSkillLines: string[] = [];

  for (const line of skills) {
    const trimmed = typeof line === 'string' ? line.trim() : '';
    if (!trimmed) {
      continue;
    }
    coreSkillLines.push(trimmed);
    const parsed = parseSkillLine(trimmed);
    if (parsed) {
      technicalskills[parsed.category] = parsed.value;
    }
  }

  if (Object.keys(technicalskills).length > 0) {
    flat.technicalskills = technicalskills;
  }
  if (coreSkillLines.length > 0) {
    flat['core-skills'] = coreSkillLines.join('\n');
  }

  return flat;
}
