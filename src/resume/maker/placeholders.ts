/**
 * Placeholder collection / derivation for Maker-style DOCX mail-merge.
 * Ported from ResumeMaker.Services.ResumeService (CollectValues, AddDerived*, etc.).
 */

const CORE_SKILLS_JSON_KEYS = [
  'core-skills',
  'Core-Skills',
  'core_skills',
  'CoreSkills',
] as const;

const ROLE_BULLETS_PLURAL_ALIAS =
  /^Role-Bullets(-\d+(?:-\d+)?)$/i;

export type MergeMeta = {
  candidateName: string;
  targetCompany: string;
  targetRole: string;
  jobDescription: string;
};

/** Case-insensitive get on a string map (mirrors OrdinalIgnoreCase dictionary). */
export function getPlaceholder(
  placeholders: Record<string, string>,
  key: string,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(placeholders, key)) {
    return placeholders[key];
  }
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(placeholders)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return undefined;
}

export function setPlaceholder(
  placeholders: Record<string, string>,
  key: string,
  value: string,
): void {
  const lower = key.toLowerCase();
  for (const existing of Object.keys(placeholders)) {
    if (existing.toLowerCase() === lower) {
      delete placeholders[existing];
      break;
    }
  }
  placeholders[key] = value;
}

export function hasPlaceholder(
  placeholders: Record<string, string>,
  key: string,
): boolean {
  return getPlaceholder(placeholders, key) !== undefined;
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function isJsonScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

export function renderNode(node: unknown): string {
  if (isJsonScalar(node)) {
    return convertValue(node);
  }
  if (Array.isArray(node)) {
    return renderArray(node);
  }
  if (isPlainObject(node)) {
    return renderObject(node);
  }
  return '';
}

function renderObject(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      continue;
    }
    const rendered = renderNode(value);
    if (!rendered.trim()) {
      continue;
    }
    if (isJsonScalar(value)) {
      lines.push(`${key}: ${rendered}`);
    } else {
      lines.push(rendered);
    }
  }
  return lines.join('\n');
}

function renderArray(array: unknown[]): string {
  const lines: string[] = [];
  for (const item of array) {
    if (item === null || item === undefined) {
      continue;
    }
    const rendered = renderNode(item);
    if (rendered.trim()) {
      lines.push(rendered);
    }
  }
  return lines.join('\n');
}

function renderScalarOrNode(node: unknown): string {
  if (isJsonScalar(node)) {
    return convertValue(node);
  }
  return renderNode(node);
}

function collectValues(
  node: unknown,
  placeholders: Record<string, string>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item !== null && item !== undefined) {
        collectValues(item, placeholders);
      }
    }
    return;
  }

  if (!isPlainObject(node)) {
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (value === null || value === undefined) {
      setPlaceholder(placeholders, key, '');
      continue;
    }

    if (isJsonScalar(value)) {
      setPlaceholder(placeholders, key, convertValue(value));
    } else {
      const rendered = renderNode(value);
      if (rendered.trim()) {
        setPlaceholder(placeholders, key, rendered);
      }
      collectValues(value, placeholders);
    }
  }
}

function tryExtractRootString(
  root: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    if (!(key in root) || root[key] === null || root[key] === undefined) {
      continue;
    }
    const value = renderScalarOrNode(root[key]).trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function extractString(root: Record<string, unknown>, key: string): string {
  if (!(key in root) || root[key] === null || root[key] === undefined) {
    return '';
  }
  return renderScalarOrNode(root[key]);
}

function addHeaderPlaceholders(
  root: Record<string, unknown>,
  placeholders: Record<string, string>,
): void {
  const title = tryExtractRootString(
    root,
    'resume-title',
    'resume_title',
    'title',
    'Title',
    'job_title',
  );
  if (title) {
    setPlaceholder(placeholders, 'Title', title);
    setPlaceholder(placeholders, 'title', title);
    setPlaceholder(placeholders, 'resume-title', title);
    setPlaceholder(placeholders, 'resume_title', title);
  }

  const name = tryExtractRootString(
    root,
    'name',
    'Name',
    'candidate_name',
    'candidateName',
  );
  if (name) {
    setPlaceholder(placeholders, 'Name', name);
    setPlaceholder(placeholders, 'name', name);
  }
}

function addCoreSkillsPlaceholders(
  root: Record<string, unknown>,
  placeholders: Record<string, string>,
): void {
  let node: unknown = undefined;
  for (const key of CORE_SKILLS_JSON_KEYS) {
    if (key in root && root[key] !== null && root[key] !== undefined) {
      node = root[key];
      break;
    }
  }

  let value: string;
  if (node === undefined) {
    const existing = getPlaceholder(placeholders, 'core-skills');
    if (!existing?.trim()) {
      return;
    }
    value = existing;
  } else if (Array.isArray(node)) {
    value = node
      .filter((item) => item !== null && item !== undefined)
      .map((item) => renderNode(item))
      .filter((line) => line.trim())
      .join('\n');
  } else {
    value = renderScalarOrNode(node);
  }

  if (!value.trim()) {
    return;
  }

  setPlaceholder(placeholders, 'core-skills', normalizeNewlines(value));
}

/** A skill group the AI left under the template's tag name: "Skill-Group-1" or "Skill-Groups-12". */
const SKILL_GROUP_TAG_ONLY = /^\s*Skill-Groups?-\d+\s*$/i;
/** The tag name in front of the group's own name: "Skill-Group-1: Cloud", "Skill-Group-2 - Data". */
const SKILL_GROUP_TAG_PREFIX = /^\s*Skill-Groups?-\d+\s*(?:[:\-–—|]\s*)?/i;
const NAME_AND_SKILLS = /^\s*([^:\n]{2,80}?)\s*:\s*([\s\S]+)$/;

/**
 * A skill group's own name and its skills, when the AI wrote the template's
 * tag name in it: "Skill-Group-1: Cloud": "AWS" → Cloud: AWS; "Skill-Group-1":
 * "Cloud: AWS" → Cloud: AWS; "Skill-Group-1": { "Cloud": "AWS" } → Cloud: AWS.
 * Otherwise the key is the name, as it is.
 */
export function namedSkillGroup(key: string, value: unknown): { name: string; value: unknown } {
  const rest = key.replace(SKILL_GROUP_TAG_PREFIX, '').trim();
  if (rest && rest !== key.trim()) return { name: rest, value };
  if (SKILL_GROUP_TAG_ONLY.test(key)) {
    if (typeof value === 'string') {
      const split = NAME_AND_SKILLS.exec(value);
      if (split) return { name: split[1]!.trim(), value: split[2]!.trim() };
    } else if (isPlainObject(value)) {
      const entries = Object.entries(value).filter(([, inner]) => inner !== null && inner !== undefined);
      if (entries.length === 1) return { name: entries[0]![0].trim(), value: entries[0]![1] };
    }
  }
  return { name: key, value };
}

function addDerivedPlaceholders(
  root: Record<string, unknown>,
  placeholders: Record<string, string>,
): void {
  addHeaderPlaceholders(root, placeholders);
  addCoreSkillsPlaceholders(root, placeholders);

  let skillsNode: unknown =
    root.technicalskills ?? root.technicalSkills ?? undefined;

  if (!isPlainObject(skillsNode)) {
    return;
  }

  let index = 1;
  const renderedSkillLines: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(skillsNode)) {
    if (rawValue === null || rawValue === undefined) {
      continue;
    }
    // The group's own name, never the template's tag ("Skill-Group-1: Cloud" → "Cloud").
    const { name: key, value } = namedSkillGroup(rawKey, rawValue);
    const rendered = renderNode(value);
    if (!rendered.trim()) {
      continue;
    }

    // Support both template styles:
    //   <Skill-Group-N> / <Skills-N>   (rui.docx)
    //   <Skill-Groups-N> / <Skills-N>  (Justin template)
    setPlaceholder(placeholders, `Skill-Group-${index}`, key);
    setPlaceholder(placeholders, `Skill-Groups-${index}`, key);
    setPlaceholder(placeholders, `Skills-${index}`, rendered);
    renderedSkillLines.push(`${key}: ${rendered}`);
    index += 1;
  }

  const renderedSkills = renderedSkillLines.join('\n');
  if (renderedSkills.trim()) {
    // Keep aggregate under technicalskills only.
    // Do not bind "Skills" here — template <Skills> means each line's value.
    setPlaceholder(placeholders, 'technicalskills', renderedSkills);
  }
}

function normalizePlaceholderAliases(
  placeholders: Record<string, string>,
): void {
  // Role-Bullets-1-2 → Role-Bullet-1-2 (singular used by Justin templates)
  for (const key of Object.keys(placeholders)) {
    const match = ROLE_BULLETS_PLURAL_ALIAS.exec(key);
    if (!match) {
      continue;
    }
    const singularKey = `Role-Bullet${match[1]}`;
    const existing = getPlaceholder(placeholders, singularKey);
    if (!existing?.trim()) {
      setPlaceholder(placeholders, singularKey, placeholders[key] ?? '');
    }
  }
}

/**
 * Walk Maker flat (or nested) JSON into the placeholder map used by merge.
 */
export function buildPlaceholders(root: unknown): Record<string, string> {
  if (!isPlainObject(root)) {
    throw new Error('JSON root must be an object.');
  }

  const placeholders: Record<string, string> = {};
  collectValues(root, placeholders);
  addDerivedPlaceholders(root, placeholders);
  normalizePlaceholderAliases(placeholders);
  return placeholders;
}

export function extractMeta(root: unknown): MergeMeta {
  if (!isPlainObject(root)) {
    throw new Error('JSON root must be an object.');
  }

  const placeholders = buildPlaceholders(root);

  let candidateName = getPlaceholder(placeholders, 'Name') ?? '';
  if (!candidateName.trim()) {
    candidateName = 'candidate';
  }

  const targetCompanyRaw = extractString(root, 'target_company');
  const targetRoleRaw = extractString(root, 'target_role');
  const jobDescription = extractString(root, 'job_description');

  return {
    candidateName,
    targetCompany: targetCompanyRaw.trim() ? targetCompanyRaw : 'Company',
    targetRole: targetRoleRaw.trim() ? targetRoleRaw : 'role',
    jobDescription,
  };
}
