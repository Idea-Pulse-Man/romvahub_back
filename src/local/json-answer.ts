import { BadGatewayError } from '../http/errors.js';

/**
 * Reading ChatGPT's answer as JSON — shared by the local ChatGPT driver and the
 * deployed API, which receives the answer text from a Resume worker (the Chrome
 * extension or the desktop agent). No browser code here.
 */

/** The balanced `{…}` spans at the top level of a text, braces inside strings ignored. */
function topLevelObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) found.push(text.slice(start, i + 1));
    }
  }
  return found;
}

/**
 * The JSON object in a chat answer: the whole answer, a fenced block, every
 * complete top-level object (last first), or the span from the first `{` to
 * the last `}`. Trailing commas and smart quotes — the two things a chat
 * answer gets wrong most — are repaired once.
 */
export function parseJsonAnswer(answer: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(answer)?.[1];
  const candidates = [answer, fenced];
  // Every complete top-level object, last first: when the text read off the
  // page also holds the prompt (and its INPUT JSON), the answer is the last.
  candidates.push(...topLevelObjects(answer).reverse());
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(answer.slice(start, end + 1));

  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    for (const text of [candidate, repair(candidate)]) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // Next.
      }
    }
  }
  throw new BadGatewayError(
    `ChatGPT's answer was not valid JSON. It began: "${answer.slice(0, 160).replace(/\s+/g, ' ')}…"`,
  );
}

function repair(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/,\s*([}\]])/g, '$1');
}
