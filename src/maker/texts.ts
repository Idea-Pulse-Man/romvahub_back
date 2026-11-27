/**
 * The words the make engine adds around the Profile's prompts, and the looks
 * it takes at an AI's answer — moved here from the desktop Resume agent
 * (resume_agent/src: deepseek-draft.js, draft-text.js, answer-fixes.js), so
 * every computer gets the same ones from the server.
 */

import { namedSkillGroup } from '../resume/maker/placeholders.js';

/** Two steps, Step 1: its answer (the information the Resume needs) must be JSON only. */
export const JSON_ONLY = 'Answer with one valid JSON object only: no text before or after it.';
/** Two steps, Step 1's second try. */
export const INVALID_JSON = 'Your answer must be one JSON object that JSON.parse accepts (double quotes, no comments, no trailing commas).';

/** Step 1's JSON, pretty-printed, or null when the answer holds no JSON object. */
export function jsonIn(text: string): string | null {
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
        return JSON.stringify(value, null, 2);
      }
    } catch {
      // Not this one.
    }
  }
  return null;
}

/** Said under every Resume request: the answer goes into the Resume word for word. */
export const FINISHED_TEXT = [
  'This JSON goes into the final Resume word for word.',
  'Fill in every field the prompt asks for, written as the prompt says: the summary, every skill group, every job title and every bullet point. Leave none of them empty.',
  'Write finished text only: no placeholders (such as "[verified percentage]", "[Confirm official job title]" or "X%"),',
  'and no notes to the candidate (such as "(verify proficiency)", "confirm", "draft" or "before submission").',
  'Bold markup that the prompt asks for (such as [text][highlight]) is fine.',
  'Where one figure or name in a sentence is unknown, write that sentence without it instead of leaving a placeholder.',
].join('\n');

const BOLD_END = '][highlight]';

/** The text without its bold markup ([…][highlight], **…**), so "[text][highlight]" is not taken for a placeholder. */
function withoutBold(text: string): string {
  let out = text.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  for (let end = out.indexOf(BOLD_END); end >= 0; end = out.indexOf(BOLD_END)) {
    let depth = 0;
    let open = end - 1;
    for (; open >= 0; open -= 1) {
      if (out[open] === ']') depth += 1;
      else if (out[open] === '[') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    out =
      open >= 0
        ? out.slice(0, open) + out.slice(open + 1, end) + out.slice(end + BOLD_END.length)
        : out.slice(0, end) + out.slice(end + BOLD_END.length);
  }
  return out.replace(/\[\/?highlight\]/gi, '');
}

const DRAFT_MARKS = [
  /\[[^[\]\n]{1,300}\]/g,
  /\b[XYN]{1,2} ?%/g,
  /\((?:verify|confirm|to be (?:confirmed|verified))[^()\n]{0,80}\)/gi,
  /\b(?:candidate verification|in this draft|draft for|placeholders?)\b/gi,
];

function parseLoose(answer: string): unknown {
  try {
    return JSON.parse(answer);
  } catch {
    const start = answer.indexOf('{');
    const end = answer.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(answer.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** A draft for the candidate to finish ("[Confirm official job title]", "by X%"): the marks found, at most 8. */
export function draftMarks(answer: string): string[] {
  const json = parseLoose(answer);
  if (json === undefined) return [];
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      const plain = withoutBold(value);
      for (const mark of DRAFT_MARKS) for (const match of plain.matchAll(mark)) found.add(match[0].trim());
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(json);
  return [...found].slice(0, 8);
}

/** The request again, with the draft's placeholders quoted. */
export function withDraftsPointedOut(request: string, marks: string[]): string {
  return [
    request,
    '',
    '================================================================================',
    'YOUR PREVIOUS ANSWER WAS A DRAFT, NOT A FINISHED RESUME',
    '================================================================================',
    'It had placeholders or notes for the candidate in it, such as:',
    ...marks.map((mark) => `- ${mark}`),
    '',
    'Write the whole JSON again, finished, with none of these.',
  ].join('\n');
}

const TAG_NAME = /^\s*Skill-Groups?-\d+\s*$/i;

/**
 * Skill groups the AI left named after the template's tag ("Skill-Group-1":
 * "Cloud: AWS, GCP") get their own name ("Cloud": "AWS, GCP"). The ones it
 * left unnamed with no name to take are returned as problems.
 */
export function nameSkillGroups(answer: string): { text: string; unnamed: string[] } {
  let parsed: { json: Record<string, unknown>; before: string; after: string } | undefined;
  try {
    parsed = { json: JSON.parse(answer), before: '', after: '' };
  } catch {
    const start = answer.indexOf('{');
    const end = answer.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = { json: JSON.parse(answer.slice(start, end + 1)), before: answer.slice(0, start), after: answer.slice(end + 1) };
      } catch {
        parsed = undefined;
      }
    }
  }
  const json = parsed?.json;
  const key = json && typeof json === 'object' ? ['technicalskills', 'technicalSkills'].find((k) => json[k]) : undefined;
  const groups = key ? json![key] : null;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return { text: answer, unnamed: [] };

  let changed = false;
  const unnamed: string[] = [];
  const named: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(groups as Record<string, unknown>)) {
    // "Skill-Group-1": "Cloud: AWS", "Skill-Group-1: Cloud": "AWS", "Skill-Group-1": { "Cloud": "AWS" } → "Cloud": "AWS".
    const own = namedSkillGroup(name, value);
    if (own.name !== name && !(own.name in named)) {
      named[own.name] = typeof own.value === 'string' ? own.value.trim() : own.value;
      changed = true;
    } else {
      if (TAG_NAME.test(name) && !(typeof value === 'string' && !value.trim())) unnamed.push(name.trim());
      named[name] = value;
    }
  }
  if (!changed) return { text: answer, unnamed };
  json![key!] = named;
  return { text: `${parsed!.before}${JSON.stringify(json, null, 2)}${parsed!.after}`, unnamed };
}
