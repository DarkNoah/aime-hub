import { FileContentError } from './types.js';
import { includesPage } from './selection.js';
import { withAbortSignal } from '../../../lib/abort.js';

/** Read original page numbers and reuse the loaded PDF when OCR needs a page subset. */
export async function readPdfPages(
  data: Uint8Array,
  selection: string | undefined,
  signal: AbortSignal,
) {
  return withAbortSignal(signal, async () => {
    const { PDFDocument } = await import('pdf-lib');
    signal.throwIfAborted();
    const source = await PDFDocument.load(data, { updateMetadata: false });
    signal.throwIfAborted();
    const count = source.getPageCount();
    if (selection && Number(selection.split(/[-,]/).at(-1)) > count)
      throw new FileContentError(
        'INVALID_PAGE_RANGES',
        `PDF 共 ${count} 页，pdf_pages 超出了页码范围。`,
      );
    const indices = source
      .getPageIndices()
      .filter((index) => !selection || includesPage(selection, index + 1));
    if (!indices.length)
      throw new FileContentError(
        'INVALID_PAGE_RANGES',
        'pdf_pages 没有匹配的 PDF 页面。',
      );
    return {
      totalPages: count,
      selectedPages: indices.map((index) => index + 1),
      select: () =>
        withAbortSignal(signal, async () => {
          signal.throwIfAborted();
          if (indices.length === count) return data;
          const selected = await PDFDocument.create();
          for (const index of indices) {
            signal.throwIfAborted();
            const [page] = await selected.copyPages(source, [index]);
            selected.addPage(page!);
          }
          signal.throwIfAborted();
          const bytes = await selected.save();
          signal.throwIfAborted();
          return bytes;
        }),
    };
  });
}
