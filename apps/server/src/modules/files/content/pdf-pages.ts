import { FileContentError } from './types.js';
import { includesPage } from './selection.js';
import { withAbortSignal } from '../../../lib/abort.js';

/** Preserve selected PDF page graphics/text for OCR services without page selection. */
export async function selectPdfPages(
  data: Uint8Array,
  selection: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return withAbortSignal(signal, async () => {
    const { PDFDocument } = await import('pdf-lib');
    signal.throwIfAborted();
    const source = await PDFDocument.load(data, { updateMetadata: false });
    signal.throwIfAborted();
    const count = source.getPageCount();
    if (Number(selection.split(/[-,]/).at(-1)) > count)
      throw new FileContentError(
        'INVALID_PAGE_RANGES',
        `PDF 共 ${count} 页，pdf_pages 超出了页码范围。`,
      );
    const indices = source
      .getPageIndices()
      .filter((index) => includesPage(selection, index + 1));
    if (!indices.length)
      throw new FileContentError(
        'INVALID_PAGE_RANGES',
        'pdf_pages 没有匹配的 PDF 页面。',
      );
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
  });
}
