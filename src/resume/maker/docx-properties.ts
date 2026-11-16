/**
 * Replaces a merged template's document properties with the candidate's own.
 *
 * A Maker template is somebody's real Word file, and everything Word stored in
 * it would otherwise ship inside every Resume made from it: the original
 * author and last editor, an edit count in the thousands, total editing time,
 * the `.dotx` it came from (with a path on the template author's PC), stale
 * page and word counts, the heading list from the *original* document (another
 * applicant's phone and email), a preview image of that document, and the
 * SharePoint library it was saved to. Recruiters and ATSs can read all of it.
 *
 * So after the merge:
 * - `docProps/core.xml` and `docProps/app.xml` are written fresh — author and
 *   last editor are the candidate, revision 1, created/modified now;
 * - the preview image, custom properties, SharePoint `customXml` parts and the
 *   attached-template link are removed, along with their relationships and
 *   content types.
 */

import path from 'node:path';
import type JSZip from 'jszip';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';

export interface DocumentProperties {
  /** Shown as Author and Last modified by. */
  author?: string;
  title?: string;
}

const CONTENT_TYPES = '[Content_Types].xml';
const ATTACHED_TEMPLATE_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Word writes these without milliseconds. */
function w3cdtf(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function coreXml({ author = '', title = '' }: DocumentProperties, now: Date): string {
  const stamp = w3cdtf(now);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dc:creator>${escapeXml(author)}</dc:creator>` +
    `<cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>` +
    '<cp:revision>1</cp:revision>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

/**
 * No page, word or line counts: the template's are wrong once merged, and Word
 * recomputes them on open. No heading list (`TitlesOfParts`) for the same reason.
 */
const APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  '<TotalTime>0</TotalTime><Application>Microsoft Office Word</Application><DocSecurity>0</DocSecurity>' +
  '<ScaleCrop>false</ScaleCrop><Company></Company><LinksUpToDate>false</LinksUpToDate>' +
  '<SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion>' +
  '</Properties>';

/** `word/_rels/document.xml.rels` → `word`; `_rels/.rels` → ``. */
function relsSourceDir(relsPath: string): string {
  return path.posix.dirname(path.posix.dirname(relsPath)).replace(/^\.$/, '');
}

function resolveTarget(relsPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return path.posix.normalize(path.posix.join(relsSourceDir(relsPath), target));
}

function elements(root: Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName(name)) as Element[];
}

async function editXml(
  zip: JSZip,
  partPath: string,
  edit: (root: Element) => boolean,
): Promise<void> {
  const file = zip.file(partPath);
  if (!file) return;
  const dom = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
  const root = dom.documentElement;
  if (root && edit(root)) zip.file(partPath, new XMLSerializer().serializeToString(dom));
}

/**
 * Deletes parts, plus every relationship pointing at them and their content
 * type overrides, so the package stays valid.
 */
async function removeParts(zip: JSZip, parts: string[]): Promise<void> {
  if (!parts.length) return;
  const gone = new Set(parts);

  for (const part of parts) {
    zip.remove(part);
    zip.remove(path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`));
  }

  const relsFiles = Object.keys(zip.files).filter(name => name.endsWith('.rels'));
  for (const relsPath of relsFiles) {
    await editXml(zip, relsPath, root => {
      let changed = false;
      for (const rel of elements(root, 'Relationship')) {
        if (rel.getAttribute('TargetMode') === 'External') continue;
        if (gone.has(resolveTarget(relsPath, rel.getAttribute('Target') ?? ''))) {
          root.removeChild(rel);
          changed = true;
        }
      }
      return changed;
    });
  }

  await editXml(zip, CONTENT_TYPES, root => {
    let changed = false;
    for (const override of elements(root, 'Override')) {
      if (gone.has((override.getAttribute('PartName') ?? '').replace(/^\//, ''))) {
        root.removeChild(override);
        changed = true;
      }
    }
    return changed;
  });
}

/** The link to the `.dotx` the template was made from, often a local path. */
async function removeAttachedTemplate(zip: JSZip): Promise<void> {
  await editXml(zip, 'word/_rels/settings.xml.rels', root => {
    const rels = elements(root, 'Relationship').filter(
      rel => rel.getAttribute('Type') === ATTACHED_TEMPLATE_REL,
    );
    rels.forEach(rel => root.removeChild(rel));
    return rels.length > 0;
  });
  await editXml(zip, 'word/settings.xml', root => {
    const links = elements(root, 'w:attachedTemplate');
    links.forEach(link => link.parentNode?.removeChild(link));
    return links.length > 0;
  });
}

/** Content controls bound to a `customXml` part need it to keep their text. */
async function usesDataBinding(zip: JSZip): Promise<boolean> {
  const parts = Object.keys(zip.files).filter(name => /^word\/[^/]+\.xml$/i.test(name));
  for (const part of parts) {
    if ((await zip.file(part)?.async('string'))?.includes('dataBinding')) return true;
  }
  return false;
}

export async function scrubDocumentProperties(
  zip: JSZip,
  properties: DocumentProperties,
  now: Date = new Date(),
): Promise<void> {
  if (zip.file('docProps/core.xml')) zip.file('docProps/core.xml', coreXml(properties, now));
  if (zip.file('docProps/app.xml')) zip.file('docProps/app.xml', APP_XML);

  const keepCustomXml = await usesDataBinding(zip);
  const leftovers = Object.keys(zip.files).filter(
    name =>
      !zip.files[name]?.dir &&
      !name.includes('/_rels/') &&
      (name === 'docProps/custom.xml' ||
        /^docProps\/thumbnail\.[a-z]+$/i.test(name) ||
        (!keepCustomXml && name.startsWith('customXml/'))),
  );
  await removeParts(zip, leftovers);
  if (!keepCustomXml) zip.remove('customXml');
  await removeAttachedTemplate(zip);
}
