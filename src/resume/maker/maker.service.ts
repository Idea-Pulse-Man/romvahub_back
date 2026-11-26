/**
 * Maker merge + PDF for RemoteOps — same approach as Resume Maker desktop:
 *
 * 1. Mail-merge flat JSON into a Word `.docx` template (OpenXML; styles stay
 *    in the template).
 * 2. PDF via Microsoft Word COM when available (ExportAsFixedFormat), matching
 *    Resume Maker's `WordComPdfExporter`. Where Word is not installed (Linux /
 *    Vercel), docx-preview lays the .docx out in Chromium with its styles; the
 *    mammoth → Chromium print is the last resort.
 */

import mammoth from 'mammoth';
import { BadGatewayError, BadRequestError } from '../../http/errors.js';
import { logger } from '../../logger.js';
import { resumeFileName } from '../resume-file-name.js';
import type { ResumeFormat, ResumePayload } from '../resume.schemas.js';
import { renderHtmlToPdf } from '../template/pdf.js';
import { mergeJsonWithTemplate, mergeStructuredWithTemplate } from './merge.js';
import type { MergeMeta } from './placeholders.js';
import { readTemplateBytes } from './templates.js';
import { docxToPdfViaPreview } from './docx-preview-pdf.js';
import { docxToPdfViaWordCom } from './word-com-pdf.js';

const CONTENT_TYPE: Record<ResumeFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export interface MakerRenderResult {
  file: Buffer;
  contentType: string;
  extension: ResumeFormat;
  fileName: string;
  meta: MergeMeta;
  templateId: string;
}

function sanitizeStem(value: string, fallback: string): string {
  const cleaned = value.replace(/[/\\?%*:|"<>#]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function fileNameFromMeta(meta: MergeMeta, extension: ResumeFormat): string {
  const parts = meta.candidateName.trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? '';
  const lastName = parts.slice(1).join(' ');
  return resumeFileName({
    firstName,
    lastName,
    extension,
    fallback: sanitizeStem(meta.candidateName, 'Resume'),
  });
}

/**
 * Wrap mammoth HTML in a printable letter page. Used only when neither Word
 * nor docx-preview could render — the content, without the template's styling.
 */
function wrapMakerHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Resume</title>
<style>
@page { size: 8.5in 11in; margin: 0.6in; }
html, body { margin: 0; padding: 0; }
body {
  font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.35;
  color: #1a1a1a;
}
p { margin: 0 0 0.35em; }
ul { margin: 0.2em 0 0.6em 1.2em; padding: 0; }
li { margin: 0 0 0.15em; }
table { border-collapse: collapse; width: 100%; }
td, th { vertical-align: top; padding: 0 0.25em 0.15em 0; }
h1, h2, h3 { margin: 0.6em 0 0.25em; font-size: 1.05em; }
</style>
</head>
<body>${body}</body>
</html>`;
}

async function docxToApproxPdf(docx: Buffer): Promise<Buffer> {
  let htmlBody: string;
  try {
    const result = await mammoth.convertToHtml({ buffer: docx });
    htmlBody = result.value;
  } catch (error) {
    logger.error({ err: error }, 'Could not convert Maker DOCX to HTML for PDF');
    throw new BadGatewayError(
      'The Resume could not be converted for PDF. Downloading it as Word still works.',
    );
  }

  try {
    return await renderHtmlToPdf(wrapMakerHtml(htmlBody));
  } catch (error) {
    logger.error({ err: error }, 'Could not print Maker Resume to PDF');
    throw new BadGatewayError(
      'The Resume could not be printed to PDF. Downloading it as Word still works.',
    );
  }
}

/** Word COM (exact layout), else docx-preview (styled), else mammoth (plain). */
export async function convertDocxToPdf(docx: Buffer): Promise<Buffer> {
  const viaWord = await docxToPdfViaWordCom(docx);
  if (viaWord?.length) {
    return viaWord;
  }
  try {
    return await docxToPdfViaPreview(docx);
  } catch (error) {
    logger.error({ err: error }, 'docx-preview could not print the Resume; using plain HTML print');
  }
  return docxToApproxPdf(docx);
}

async function toFormat(
  docx: Buffer,
  format: ResumeFormat,
  meta: MergeMeta,
  templateId: string,
): Promise<MakerRenderResult> {
  if (format === 'docx') {
    return {
      file: docx,
      contentType: CONTENT_TYPE.docx,
      extension: 'docx',
      fileName: fileNameFromMeta(meta, 'docx'),
      meta,
      templateId,
    };
  }

  const pdf = await convertDocxToPdf(docx);
  return {
    file: pdf,
    contentType: CONTENT_TYPE.pdf,
    extension: 'pdf',
    fileName: fileNameFromMeta(meta, 'pdf'),
    meta,
    templateId,
  };
}

/**
 * Studio path: paste Maker flat JSON (or nested Maker JSON) + template → file.
 */
export async function processMakerJson(input: {
  json: string | object;
  format: ResumeFormat;
  templateId?: string;
  /** The template's bytes, when the caller has them (a stored version): no lookup by name. */
  template?: { id: string; bytes: Buffer };
}): Promise<MakerRenderResult> {
  const template = input.template ?? (await readTemplateBytes(input.templateId));

  let merged;
  try {
    merged = await mergeJsonWithTemplate(template.bytes, input.json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BadRequestError(message.startsWith('Invalid JSON') || message.includes('JSON')
      ? message
      : `Could not merge the Resume: ${message}`);
  }

  return toFormat(merged.docx, input.format, merged.meta, template.id);
}

/**
 * Applications path: structured AI payload + profile name → Maker flat → file.
 * Same Word-template pipeline as Resume Maker / the studio page.
 */
export async function renderStructuredWithMaker(input: {
  document: ResumePayload;
  format: ResumeFormat;
  name?: string;
  jobDescription?: string;
  templateId?: string;
  /** Employers to use when the document carries none (the profile's work history). */
  fallbackCompanies?: string[];
  /** The template's bytes, when the caller has them (a stored version): no lookup by name. */
  template?: { id: string; bytes: Buffer };
}): Promise<MakerRenderResult> {
  const template = input.template ?? (await readTemplateBytes(input.templateId));

  const flatInput = {
    company: input.document.company,
    role: input.document.role,
    roleTitles: input.document.roleTitles,
    summary: input.document.summary,
    skills: input.document.skills,
    bullets: input.document.bullets,
    companies: input.document.companies?.length ? input.document.companies : input.fallbackCompanies,
    name: input.name,
    jobDescription: input.jobDescription,
  };

  let merged: Awaited<ReturnType<typeof mergeStructuredWithTemplate>>;
  try {
    merged = await mergeStructuredWithTemplate(template.bytes, flatInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BadRequestError(`Could not merge the Resume: ${message}`);
  }

  // Prefer the profile display name for the download filename when JSON had none.
  if (input.name?.trim() && merged.meta.candidateName === 'candidate') {
    merged.meta = { ...merged.meta, candidateName: input.name.trim() };
  }

  return toFormat(merged.docx, input.format, merged.meta, template.id);
}
