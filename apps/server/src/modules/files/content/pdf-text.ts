import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { includesPage } from './selection.js';
import { FileContentError } from './types.js';
import { withAbortSignal } from '../../../lib/abort.js';

const require = createRequire(import.meta.url);

/** Decode local text with bundled CMaps, including non-embedded Chinese fonts. */
export async function pdfText(
  data: Uint8Array,
  selection: string | undefined,
  signal: AbortSignal,
) {
  return withAbortSignal(signal, async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    signal.throwIfAborted();
    const root = dirname(require.resolve('pdfjs-dist/package.json'));
    const task = getDocument({
      data: new Uint8Array(data),
      cMapUrl: join(root, 'cmaps') + sep,
      cMapPacked: true,
      standardFontDataUrl: join(root, 'standard_fonts') + sep,
      stopAtErrors: true,
      verbosity: 0,
    });
    const abort = () => {
      void task.destroy().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const doc = await task.promise;
      if (doc.numPages > 5000)
        throw new FileContentError(
          'FILE_PARSE_INCOMPLETE',
          'PDF 页数超过解析限制，请拆分后读取。',
        );
      if (selection && Number(selection.split(/[-,]/).at(-1)) > doc.numPages)
        throw new FileContentError(
          'INVALID_PAGE_RANGES',
          `PDF 共 ${doc.numPages} 页，pdf_pages 超出了页码范围。`,
        );
      const pages: string[] = [];
      let bytes = 0;
      for (let index = 1; index <= doc.numPages; index++) {
        signal.throwIfAborted();
        if (selection && !includesPage(selection, index)) continue;
        const page = await doc.getPage(index);
        const reader = page.streamTextContent().getReader();
        const fragments: string[] = [];
        try {
          while (true) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            for (const item of value.items) {
              if (!('str' in item)) continue;
              bytes += Buffer.byteLength(item.str);
              if (bytes > 64 * 1024 * 1024)
                throw new FileContentError(
                  'FILE_PARSE_INCOMPLETE',
                  'PDF 文字超过解析限制，请拆分后读取。',
                );
              fragments.push(item.str + (item.hasEOL ? '\n' : ' '));
            }
          }
        } finally {
          reader.releaseLock();
          page.cleanup();
        }
        const text = fragments.join('').trim();
        if (text) pages.push(`## Page ${index}\n\n${text}`);
      }
      signal.throwIfAborted();
      return pages.join('\n\n');
    } finally {
      signal.removeEventListener('abort', abort);
      await task.destroy();
    }
  });
}
