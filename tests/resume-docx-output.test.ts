import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { mergeJsonWithTemplate } from '../src/resume/maker/merge.js';
import { patchDocxPreview, prepareForPreview } from '../src/resume/maker/docx-preview-pdf.js';

/**
 * What a generated Resume carries besides its text: the Word file's properties,
 * and the copy of it the Word-less PDF path lays out.
 */

const require = createRequire(import.meta.url);
const TEMPLATES = path.resolve('assets/resume-templates');
const templateIds = readdirSync(TEMPLATES).filter(name => name.endsWith('.docx'));

async function merged(templateId: string, name = 'Jane Doe'): Promise<JSZip> {
  const { docx } = await mergeJsonWithTemplate(readFileSync(path.join(TEMPLATES, templateId)), { Name: name });
  return JSZip.loadAsync(docx);
}

describe('generated Resume properties', () => {
  it.each(templateIds)('%s: names the candidate, and keeps nothing of the template author', async id => {
    const zip = await merged(id);
    const core = await zip.file('docProps/core.xml')!.async('string');
    expect(core).toContain('<dc:creator>Jane Doe</dc:creator>');
    expect(core).toContain('<cp:lastModifiedBy>Jane Doe</cp:lastModifiedBy>');
    expect(core).toContain('<cp:revision>1</cp:revision>');

    const app = (await zip.file('docProps/app.xml')?.async('string')) ?? '';
    expect(app).not.toMatch(/<Template>|<TitlesOfParts>|<Pages>|<Words>/);

    const names = Object.keys(zip.files);
    expect(names.filter(name => /^customXml\/|^docProps\/(custom\.xml|thumbnail\.)/.test(name))).toEqual([]);

    // Nothing left pointing at a removed part, nor at the template's .dotx.
    for (const rels of names.filter(name => name.endsWith('.rels'))) {
      const xml = await zip.file(rels)!.async('string');
      expect(xml).not.toMatch(/customXml|thumbnail|custom\.xml|attachedTemplate/);
    }
    const types = await zip.file('[Content_Types].xml')!.async('string');
    expect(types).not.toMatch(/customXml|custom\.xml/);
    expect(await zip.file('word/settings.xml')!.async('string')).not.toContain('attachedTemplate');
  });

  it('leaves the author blank rather than writing a placeholder name', async () => {
    const { docx } = await mergeJsonWithTemplate(readFileSync(path.join(TEMPLATES, 'default.docx')), {});
    const core = await (await JSZip.loadAsync(docx)).file('docProps/core.xml')!.async('string');
    expect(core).toContain('<dc:creator></dc:creator>');
    expect(core).toContain('<dc:title>Resume</dc:title>');
  });
});

describe('PDF without Word (docx-preview)', () => {
  it('still applies its fixes to the installed docx-preview', () => {
    const source = readFileSync(
      path.join(path.dirname(require.resolve('docx-preview')), 'docx-preview.js'),
      'utf8',
    );
    const patched = patchDocxPreview(source);
    expect(patched).toContain('window.__docxRefreshTabStops');
    expect(patched).toContain('width += ebb.width * pixelToPoint');
  });

  it('turns heading rule shapes into borders and gives unstyled paragraphs the default style', async () => {
    const zip = await merged('William_Kolega_Template_2.docx');
    const docx = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const prepared = await prepareForPreview(docx);
    const xml = await (await JSZip.loadAsync(prepared.docx)).file('word/document.xml')!.async('string');

    expect(xml).not.toContain('prst="line"');
    expect(xml).toMatch(/<w:pBdr><w:top w:val="single" w:sz="\d+" w:space="0" w:color="[0-9A-F]{6}"\/>/);
    // Every paragraph names its style; none is left to docx-preview's defaults.
    const paragraphs = xml.match(/<w:p[ >]/g)?.length ?? 0;
    expect(xml.match(/<w:pStyle /g)?.length).toBe(paragraphs);
    expect(prepared.keepWithNext).toContain('docx_heading1');
  });

  it.each(['Justin_Updated_2026.8.17.docx', 'William_Kolega_Template_2.docx'])(
    '%s: draws Symbol/Wingdings bullets as U+2022, which Chromium has a font for',
    async id => {
      const zip = await merged(id);
      const before = await zip.file('word/numbering.xml')!.async('string');
      expect(before).toMatch(/w:lvlText w:val=""/);

      const docx = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
      const prepared = await prepareForPreview(docx);
      const xml = await (await JSZip.loadAsync(prepared.docx)).file('word/numbering.xml')!.async('string');
      expect(xml).not.toMatch(/[-]/);
      expect(xml).toContain('w:lvlText w:val="•"');
      expect(xml).not.toMatch(/w:rFonts[^>]*w:ascii="(Symbol|Wingdings)"/);
    },
  );

  it('does not touch the Word file that is downloaded', async () => {
    const zip = await merged('William_Kolega_Template_2.docx');
    const docx = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const before = Buffer.from(docx);
    await prepareForPreview(docx);
    expect(docx.equals(before)).toBe(true);
  });
});
