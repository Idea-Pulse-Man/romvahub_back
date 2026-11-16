/**
 * Resume Maker mail-merge: flat JSON + DOCX template → merged DOCX.
 */

export {
  buildPlaceholders,
  extractMeta,
  getPlaceholder,
  normalizeNewlines,
  type MergeMeta,
} from './placeholders.js';
export { mergeTemplate } from './merge-docx.js';
export {
  structuredToFlat,
  type StructuredResumeInput,
  type MakerFlatJson,
} from './structured-to-flat.js';
export {
  mergeJsonWithTemplate,
  mergeStructuredWithTemplate,
} from './merge.js';
export {
  listTemplates,
  readTemplateBytes,
  saveUploadedTemplate,
  deleteTemplate,
  type TemplateInfo,
} from './templates.js';
export {
  processMakerJson,
  renderStructuredWithMaker,
  convertDocxToPdf,
  type MakerRenderResult,
} from './maker.service.js';
