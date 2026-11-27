import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { getSkillEntries } from '../resume/maker/merge-docx.js';
import { buildPlaceholders, getPlaceholder } from '../resume/maker/placeholders.js';
import { structuredToFlat } from '../resume/maker/structured-to-flat.js';
import { readTemplateBytes } from '../resume/maker/templates.js';
import { AiResumeSchema } from '../resume/resume.schemas.js';

/**
 * The look at ChatGPT's Resume JSON before a Resume is built from it.
 *
 * The Word template is a mail-merge: each `<Tag>` in it is filled from the
 * answer's keys, and a tag the answer does not fill is left blank — a key
 * named differently, or a section left out, comes out as an empty
 * "PROFESSIONAL SUMMARY" or a job with no title, with nothing reported.
 *
 * So the answer is filled into the Profile's own template's tags exactly as
 * the merge would, and the sections a Resume cannot do without are checked:
 * the summary, the skills, each job's title, and at least one bullet point
 * per job. Other tags (a name, a heading) are not required.
 */

const PLACEHOLDER = /<\s*([^<>]+?)\s*>/g;
const SKILL_GROUP = /^Skill-Groups?(?:-\d+)?$/i;
const SKILL_VALUE = /^Skills(?:-\d+)?$/i;
const ROLE_TITLE = /^Role-Title-(\d+)$/i;
const ROLE_BULLET = /^Role-Bullets?-(\d+)-(\d+)$/i;

/** The template's tags, by template id and size: templates rarely change, and a check runs per answer. */
const tagCache = new Map<string, string[]>();

async function templateTags(templateId: string | undefined): Promise<string[]> {
  const template = await readTemplateBytes(templateId);
  const key = `${template.id}:${template.bytes.length}`;
  const cached = tagCache.get(key);
  if (cached) return cached;
  const list = await tagsInTemplate(template.bytes);
  tagCache.set(key, list);
  return list;
}

/** The `<Tag>`s of a .docx template — its body, headers and footers. */
export async function tagsInTemplate(bytes: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.keys(zip.files).filter((name) =>
    /^word\/(document|header[^/]*|footer[^/]*)\.xml$/i.test(name.replace(/\\/g, '/')),
  );
  const tags = new Set<string>();
  for (const part of parts) {
    const xml = await zip.file(part)!.async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    // A tag can be split across runs, so each paragraph's text is read whole.
    const paragraphs = doc.getElementsByTagName('w:p');
    for (let p = 0; p < paragraphs.length; p += 1) {
      const texts = paragraphs[p]!.getElementsByTagName('w:t');
      let text = '';
      for (let t = 0; t < texts.length; t += 1) text += texts[t]!.textContent ?? '';
      for (const match of text.matchAll(PLACEHOLDER)) tags.add((match[1] ?? '').trim());
    }
  }
  return [...tags].filter(Boolean);
}

/** The answer as the merge sees it: the same placeholder map `finishResume` would fill the template from. */
function placeholdersFor(json: object, context: { name?: string; fallbackCompanies: string[] }) {
  const structured = AiResumeSchema.safeParse(json);
  if (!structured.success) return buildPlaceholders(json);
  const document = structured.data;
  return buildPlaceholders(
    structuredToFlat({
      company: document.company,
      role: document.role,
      roleTitles: document.roleTitles,
      summary: document.summary,
      skills: document.skills,
      bullets: document.bullets,
      // This shape carries no employers: the build takes the Profile's work history.
      companies: context.fallbackCompanies,
      name: context.name,
    }),
  );
}

/**
 * What is missing from `json` for the template `templateId`, in words fit to
 * show ChatGPT — empty when the Resume can be built as it is.
 */
export async function resumeAnswerProblems(
  json: object,
  context: { templateId?: string; name?: string; fallbackCompanies: string[]; requestedBullets?: Map<number, number> },
): Promise<string[]> {
  return problemsForTags(await templateTags(context.templateId), json, context);
}

/**
 * How many bullet points the prompt asks for, per job: the highest
 * "Role-Bullet-<job>-<n>" it names (so "Role-Bullet-4-1 … Role-Bullet-4-5" is 5).
 */
export function bulletsNamedIn(prompt: string): Map<number, number> {
  const most = new Map<number, number>();
  for (const match of prompt.matchAll(/Role-Bullets?-(\d+)-(\d+)/gi)) {
    const role = Number(match[1]);
    most.set(role, Math.max(most.get(role) ?? 0, Number(match[2])));
  }
  return most;
}

/**
 * `resumeAnswerProblems` for a template's tags already read. With
 * `requestedBullets` (the bullet tags the prompt names), a job the answer
 * writes must also fill each of its template's bullets the prompt asks for —
 * not only one.
 */
export function problemsForTags(
  tags: string[],
  json: object,
  context: { name?: string; fallbackCompanies: string[]; requestedBullets?: Map<number, number> },
): string[] {
  const placeholders = placeholdersFor(json, context);
  const filled = (tag: string) => (getPlaceholder(placeholders, tag) ?? '').trim().length > 0;
  const problems: string[] = [];

  // The summary — the Resume's own, not a job's (<Role-Summary-N>).
  for (const tag of tags.filter((t) => /summary/i.test(t) && !/^role/i.test(t))) {
    if (!filled(tag)) problems.push(`the professional summary is empty (the template's <${tag}>)`);
  }

  // The skills: grouped lines (<Skill-Group-N>: <Skills-N>) and/or one block
  // (<Core-Skills>…). Empty only when none of them has anything.
  const groupedSkills = tags.some((t) => SKILL_GROUP.test(t) || SKILL_VALUE.test(t));
  const blockSkillTags = tags.filter((t) => /skill/i.test(t) && !SKILL_GROUP.test(t) && !SKILL_VALUE.test(t));
  if (groupedSkills || blockSkillTags.length) {
    const entries = groupedSkills ? getSkillEntries(placeholders) : [];
    const anySkills = entries.some((entry) => entry.value.trim()) || blockSkillTags.some(filled);
    if (!anySkills) {
      problems.push('the technical skills are empty');
    } else {
      for (const entry of entries) {
        if (!entry.value.trim()) problems.push(`the skill group "${entry.group.trim() || '?'}" has no skills`);
      }
    }
  }

  // The jobs. A template can have more job slots than the person has jobs,
  // so the jobs checked are those up to the last one the answer fills: each
  // needs its title and at least one bullet point. None filled at all is the
  // whole experience section missing.
  const titles = new Map<number, string>();
  const bullets = new Map<number, string[]>();
  for (const tag of tags) {
    const titleOf = ROLE_TITLE.exec(tag)?.[1];
    if (titleOf) titles.set(Number(titleOf), tag);
    const bulletOf = ROLE_BULLET.exec(tag)?.[1];
    if (bulletOf) bullets.set(Number(bulletOf), [...(bullets.get(Number(bulletOf)) ?? []), tag]);
  }
  const roles = [...new Set([...titles.keys(), ...bullets.keys()])].sort((a, b) => a - b);
  const used = roles.filter((role) => (titles.has(role) && filled(titles.get(role)!)) || (bullets.get(role) ?? []).some(filled));
  if (roles.length && !used.length) {
    problems.push('the professional experience is empty: no job titles and no bullet points');
  }
  const lastUsed = used.length ? used[used.length - 1]! : 0;
  for (const role of roles.filter((r) => r <= lastUsed)) {
    const titleTag = titles.get(role);
    if (titleTag && !filled(titleTag)) problems.push(`job ${role} has no job title (the template's <${titleTag}>)`);
    const bulletTags = bullets.get(role) ?? [];
    if (bulletTags.length && !bulletTags.some(filled)) {
      problems.push(`job ${role} has no bullet points (the template's <${bulletTags[0]}>…)`);
    } else if (context.requestedBullets?.size) {
      // Each bullet the prompt asks for (up to its highest for this job) and the template has a place for.
      const most = context.requestedBullets.get(role) ?? 0;
      const wanted = bulletTags.filter((tag) => Number(ROLE_BULLET.exec(tag)?.[2] ?? 0) <= most);
      const empty = wanted.filter((tag) => !filled(tag));
      if (empty.length) {
        problems.push(
          `job ${role} has ${wanted.length - empty.length} of the ${wanted.length} bullet points asked for: write ${empty.map((tag) => `"${tag}"`).join(', ')} too`,
        );
      }
    }
  }

  return problems;
}

/**
 * The message for a second chat when the first answer could not be used:
 * the same request, with what was wrong spelled out.
 */
export function resumeRetryMessage(resumeMessage: string, problems: string[], json: unknown): string {
  const keys =
    json && typeof json === 'object' && !Array.isArray(json) ? Object.keys(json).slice(0, 40).join(', ') : '';
  return [
    resumeMessage,
    '',
    '================================================================================',
    'YOUR PREVIOUS ANSWER TO THIS REQUEST COULD NOT BE USED',
    '================================================================================',
    ...problems.map((problem) => `- ${problem}`),
    ...(keys ? [`(Its top-level keys were: ${keys}.)`] : []),
    '',
    'Write the whole JSON again, complete: every section filled in, using exactly the key names and the shape the prompt above asks for.',
    'Reply with the JSON only, in a single ```json code block.',
  ].join('\n');
}
