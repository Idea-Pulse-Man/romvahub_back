/**
 * High-level Maker merge entry points (flat JSON or structured RemoteOps payload).
 */

import {
  buildPlaceholders,
  extractMeta,
  type MergeMeta,
} from './placeholders.js';
import { mergeTemplate } from './merge-docx.js';
import {
  structuredToFlat,
  type StructuredResumeInput,
  type MakerFlatJson,
} from './structured-to-flat.js';

function parseJsonInput(jsonInput: string | object): unknown {
  if (typeof jsonInput === 'string') {
    try {
      return JSON.parse(jsonInput) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON: ${message}`);
    }
  }
  return jsonInput;
}

/**
 * Maker flat JSON (string or object) into a .docx template.
 * Does not convert RemoteOps structured payloads — use `structuredToFlat` first.
 */
export async function mergeJsonWithTemplate(
  templateBytes: Buffer,
  jsonInput: string | object,
): Promise<{ docx: Buffer; meta: MergeMeta }> {
  if (!templateBytes?.length) {
    throw new Error('Template bytes are required.');
  }

  const root = parseJsonInput(jsonInput);
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('JSON root must be an object.');
  }

  const placeholders = buildPlaceholders(root);
  const meta = extractMeta(root);
  // 'candidate' is extractMeta's stand-in when the JSON has no name.
  const author = meta.candidateName === 'candidate' ? '' : meta.candidateName.trim();
  const docx = await mergeTemplate(templateBytes, placeholders, {
    author,
    title: author ? `${author} Resume` : 'Resume',
  });
  return { docx, meta };
}

/** Structured RemoteOps payload → flat → merge into template. */
export async function mergeStructuredWithTemplate(
  templateBytes: Buffer,
  structured: StructuredResumeInput,
): Promise<{ docx: Buffer; meta: MergeMeta; flat: MakerFlatJson }> {
  const flat = structuredToFlat(structured);
  const { docx, meta } = await mergeJsonWithTemplate(templateBytes, flat);
  return { docx, meta, flat };
}
