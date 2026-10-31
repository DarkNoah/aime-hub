import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { Workspace, LocalFilesystem } from '@mastra/core/workspace';
import { noopObserve } from '@mastra/core/tools';
import { defaultReadFileConfig } from '@aime/shared/tools';
import { createReadFileTool } from '../../mastra/tools/read_file.js';
import { parseFileContent } from '../files/content/parse.js';
import { FileContentError } from '../files/content/types.js';

async function pdfFixture(texts = ['First page content', 'Last page END']) {
  const pdf = await PDFDocument.create();
  for (const text of texts) pdf.addPage().drawText(text);
  return pdf.save();
}

test('PDF page selection is applied before OCR for endpoints without page ranges', async () => {
  const source = await pdfFixture(['Page ONE', 'Page TWO', 'Page THREE']);
  const original = source.slice();
  let calls = 0;
  const result = await parseFileContent(
    { fileName: 'report.pdf', data: source },
    { parameters: { pdf_pages: '1,3' } },
    {
      resolveOcr: async () => ({
        model: {
          provider: 'xinference',
          modelId: 'ocr',
          supportsPageRanges: false,
          doOCR: async (options) => {
            calls++;
            assert.equal(options.pageRanges, undefined);
            assert.ok(options.input.data);
            const selected = await parseFileContent({
              fileName: 'selected.pdf',
              data: options.input.data,
            });
            assert.match(selected.text, /Page ONE/);
            assert.match(selected.text, /Page THREE/);
            assert.doesNotMatch(selected.text, /Page TWO/);
            return { markdown: 'OCR selected pages', taskId: 'selected' };
          },
        },
      }),
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.text, 'OCR selected pages');
  assert.deepEqual(source, original);
});

test('PDF OCR errors and empty results fall back to selected local text even in strict extraction mode', async () => {
  for (const failure of ['resolve', 'recognize', 'empty']) {
    const result = await parseFileContent(
      { fileName: 'report.pdf', data: await pdfFixture() },
      { parameters: { pdf_pages: '2' } },
      {
        resolveOcr: async () => {
          if (failure === 'resolve') throw new Error('secret provider error');
          return {
            model: {
              provider: 'xinference',
              modelId: 'ocr',
              supportsPageRanges: false,
              doOCR: async () => {
                if (failure === 'recognize')
                  throw new Error('secret provider error');
                return { markdown: '  ', taskId: 'empty' };
              },
            },
          };
        },
      },
    );
    assert.match(result.text, /Last page END/);
    assert.doesNotMatch(result.text, /First page content/);
    assert.ok(result.warnings?.length);
    assert.doesNotMatch(JSON.stringify(result), /secret provider error/);
  }
});

test('invalid PDF page selections and cancellation never fall through to full-document OCR', async () => {
  let calls = 0;
  const dependencies = {
    resolveOcr: async () => ({
      model: {
        provider: 'xinference',
        modelId: 'ocr',
        supportsPageRanges: false,
        doOCR: async () => {
          calls++;
          return { markdown: 'unexpected', taskId: 'bad' };
        },
      },
    }),
  };
  await assert.rejects(
    parseFileContent(
      { fileName: 'report.pdf', data: await pdfFixture() },
      { parameters: { pdf_pages: '3' } },
      dependencies,
    ),
    (error: unknown) =>
      error instanceof FileContentError && error.code === 'INVALID_PAGE_RANGES',
  );
  await assert.rejects(
    parseFileContent(
      { fileName: 'report.pdf', data: await pdfFixture() },
      { parameters: { pdf_pages: '1' }, signal: AbortSignal.abort() },
      dependencies,
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
});

test('PDF encoding never bypasses OCR, including uploaded paths', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-reading-'));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory }),
  });
  await workspace.init();
  t.after(async () => {
    await workspace.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, '.uploads'), { recursive: true });
  await writeFile(
    join(directory, '.uploads', 'invoice.pdf'),
    await pdfFixture(),
  );
  let calls = 0;
  const tool = createReadFileTool(defaultReadFileConfig, {
    resolveModel: async () => ({
      reference: 'ocr/test',
      model: {
        provider: 'test',
        modelId: 'ocr',
        doOCR: async () => {
          calls++;
          return { markdown: '# OCR invoice', taskId: 'test' };
        },
      },
    }),
  });
  for (const encoding of [
    'utf-8',
    'utf8',
    'base64',
    'hex',
    'binary',
  ] as const) {
    const result = await tool.execute!(
      { path: '/.uploads/invoice.pdf', encoding, showLineNumbers: false },
      { workspace, observe: noopObserve },
    );
    assert.ok(result && typeof result === 'object' && 'ok' in result);
    assert.equal(result.ok, true);
    assert.match(result.content[0].text, /OCR invoice/);
  }
  assert.equal(calls, 5);
});

test('PDF text fallback decodes Chinese CMaps without embedded fonts', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const context = pdf.context;
  const font = context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'STSong-Light',
      Encoding: 'UniGB-UCS2-H',
      DescendantFonts: [
        context.register(
          context.obj({
            Type: 'Font',
            Subtype: 'CIDFontType0',
            BaseFont: 'STSong-Light',
            CIDSystemInfo: {
              Registry: PDFString.of('Adobe'),
              Ordering: PDFString.of('GB1'),
              Supplement: 4,
            },
          }),
        ),
      ],
    }),
  );
  page.node.set(PDFName.of('Resources'), context.obj({ Font: { F1: font } }));
  const expected = '电子发票 26442000009097120891 金额 665.50';
  const encoded = Buffer.from(expected, 'utf16le').swap16().toString('hex');
  page.node.set(
    PDFName.of('Contents'),
    context.register(
      context.flateStream(`BT /F1 12 Tf 20 700 Td <${encoded}> Tj ET`),
    ),
  );
  const result = await parseFileContent({
    fileName: 'invoice.pdf',
    data: await pdf.save(),
  });
  assert.ok(result.text.includes('电子发票'));
  assert.ok(result.text.includes('26442000009097120891'));
  assert.ok(result.text.includes('665.50'));
});
