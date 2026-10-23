import { extname } from 'node:path';
import type { OfficeContentNode, OfficeIssue } from 'officeparser';
import { includesPage, pageSelection } from './selection.js';
import { spreadsheetContent } from './spreadsheet.js';
import { withAbortSignal } from '../../../lib/abort.js';
import { inspectImageFile, maxBinaryFileBytes } from '../binary-file.js';
import {
  fileContentFormat,
  fileNameForMimeType,
  legacyOfficeExtensions,
} from './formats.js';
import {
  FileContentError,
  type FileContent,
  type FileContentDependencies,
  type FileContentInput,
  type FileContentOptions,
} from './types.js';

const incompleteContentCodes = new Set([
  'TABLE_CELL_LIMIT_EXCEEDED',
  'REPEATED_CONTENT_LIMIT_EXCEEDED',
  'TABLE_GRID_LIMIT_EXCEEDED',
  'PDF_CONTENT_LIMIT_EXCEEDED',
  'PAGE_LOAD_FAILED',
  'CONTENT_PART_NOT_READ',
  'ALT_CHUNK_NOT_READ',
]);

function assertCompleteDocument(issues: OfficeIssue[]) {
  if (
    issues.some(
      (issue) =>
        issue.type === 'error' || incompleteContentCodes.has(issue.code),
    )
  )
    throw new FileContentError(
      'FILE_PARSE_INCOMPLETE',
      '文档部分内容未能完整解析，可能达到解析安全限制。请拆分文件或转换格式后重试。',
    );
}

function sectionHeading(text: string): OfficeContentNode {
  return {
    type: 'heading',
    text,
    metadata: { level: 2 },
    children: [{ type: 'text', text }],
  };
}

export function validateFileContentSize(size: number, allowEmpty = false) {
  if (!size && !allowEmpty)
    throw new FileContentError('FILE_EMPTY', '文件内容为空。');
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBinaryFileBytes)
    throw new FileContentError(
      'FILE_TOO_LARGE',
      '文件超过 200 MB，请拆分后读取。',
    );
}

/**
 * Convert file bytes to COMPLETE Markdown/text and optional image bytes for the current model.
 * No line/character budgets, model context limits, tool schemas or workspace needed.
 * Input/decompression safety limits reject the file instead of clipping content.
 */
export async function parseFileContent(
  input: FileContentInput,
  options: FileContentOptions = {},
  dependencies: FileContentDependencies = {},
): Promise<FileContent> {
  const signal = options.signal ?? new AbortController().signal;
  return withAbortSignal(signal, async () => {
    validateFileContentSize(input.data.byteLength, true);
    const data = Buffer.from(input.data);
    const fileName = fileNameForMimeType(input.fileName, input.mimeType);
    const extension = extname(fileName).toLowerCase();
    const format = fileContentFormat(fileName);
    if (format && format.kind !== 'text') validateFileContentSize(data.length);
    const parameters = options.parameters ?? {};
    const pageRanges = pageSelection(parameters.pdf_pages, 'pdf_pages');
    let metadata = {
      fileName,
      mimeType:
        format?.mimeType ??
        (['.md', '.markdown'].includes(extension)
          ? 'text/markdown'
          : 'text/plain'),
      kind: format?.kind ?? ('text' as FileContent['kind']),
      size: data.length,
    };
    const textResult = (
      text: string,
      outputFormat: 'markdown' | 'text' = 'markdown',
    ): FileContent => ({
      ...metadata,
      type: 'text',
      format: outputFormat,
      text,
    });

    if (pageRanges !== undefined && metadata.kind !== 'pdf')
      throw new FileContentError(
        'INVALID_PAGE_RANGES',
        'pdf_pages 仅适用于 PDF。',
      );
    if (metadata.kind === 'image')
      metadata = { ...metadata, ...inspectImageFile(data, fileName) };
    if (
      metadata.kind === 'pdf' &&
      !data.subarray(0, 1024).includes(Buffer.from('%PDF-'))
    )
      throw new FileContentError('FILE_INVALID_FORMAT', '文件不是有效的 PDF。');

    if (
      parameters.image_base64 !== undefined &&
      typeof parameters.image_base64 !== 'boolean'
    )
      throw new FileContentError(
        'INVALID_FILE_PARAMETERS',
        'image_base64 应为布尔值。',
      );
    const images =
      metadata.kind === 'image' &&
      parameters.image_base64 !== false &&
      options.model?.modalitiesInput.includes('image') &&
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
        metadata.mimeType,
      )
        ? [
            {
              data: data.toString('base64'),
              mimeType: metadata.mimeType,
              fileName: metadata.fileName,
            },
          ]
        : undefined;
    if (metadata.kind === 'image' || metadata.kind === 'pdf') {
      let resolved:
        | Awaited<
            ReturnType<NonNullable<FileContentDependencies['resolveOcr']>>
          >
        | undefined;
      try {
        resolved = await dependencies.resolveOcr?.();
      } catch (error) {
        // A missing default can fall back to a text PDF. A broken configured provider cannot.
        if (!(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'OCR_NOT_CONFIGURED'
        ))
          throw error;
      }
      signal.throwIfAborted();
      if (resolved) {
        if (
          pageRanges !== undefined &&
          resolved.model.supportsPageRanges === false
        )
          throw new FileContentError(
            'PAGE_RANGES_UNSUPPORTED',
            '当前 OCR 接口不支持 PDF 页码选择，请省略 pdf_pages 后读取完整 PDF。',
          );
        try {
          const result = await resolved.model.doOCR({
            input: { data, fileName: metadata.fileName },
            pageRanges: pageRanges,
            abortSignal: signal,
          });
          signal.throwIfAborted();
          return {
            ...textResult(result.markdown),
            images,
            model: resolved.reference,
            taskId: result.taskId,
            archiveUrl: result.archiveUrl,
            resultUrl: result.resultUrl,
          };
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof FileContentError) throw error;
          throw new FileContentError(
            'OCR_FAILED',
            '文档识别失败，请检查文件及 OCR 模型配置。',
          );
        }
      }
      if (metadata.kind === 'image') {
        if (images)
          return {
            ...textResult(''),
            images,
            warnings: ['未配置 OCR 模型，已提供原始图片供当前模型读取。'],
          };
        throw new FileContentError(
          'OCR_NOT_CONFIGURED',
          '图片读取需要配置 OCR 模型，或选择支持图片输入的当前模型。BMP、TIFF、JP2 请配置 OCR 或转换为 PNG/JPEG。',
        );
      }
    }

    if (metadata.kind === 'audio' || metadata.kind === 'video') {
      if (!dependencies.transcribe)
        throw new FileContentError(
          'ASR_NOT_CONFIGURED',
          '音视频读取需要配置默认 ASR 模型；视频仅分析音轨。',
        );
      try {
        const text = await dependencies.transcribe(data, signal);
        signal.throwIfAborted();
        return textResult(text, 'text');
      } catch {
        signal.throwIfAborted();
        throw new FileContentError(
          'ASR_FAILED',
          '音视频转写失败，请检查文件及 ASR 模型配置。',
        );
      }
    }

    if (metadata.kind === 'document' || metadata.kind === 'pdf') {
      try {
        const { OfficeParser } = await import('officeparser');
        signal.throwIfAborted();
        const document = await OfficeParser.parseOffice(data, {
          fileType: (extension === '.htm'
            ? 'html'
            : extension.slice(1)) as import('officeparser').SupportedFileType,
          abortSignal: signal,
          ...(metadata.kind === 'pdf' && pageRanges
            ? { pdfParserConfig: { pageRange: pageRanges } }
            : {}),
          extractAttachments: false,
          includeRawContent: false,
          ocr: false,
          decompressionLimits: {
            maxUncompressedBytes: 64 * 1024 * 1024,
            maxZipEntries: 5000,
          },
        });
        signal.throwIfAborted();
        assertCompleteDocument(document.warnings);
        if (
          metadata.kind === 'pdf' &&
          document.warnings.some(
            (issue) =>
              issue.code === 'PDF_NO_TEXT_EXTRACTED' ||
              issue.code === 'PDF_TEXT_ENCODING_SUSPECT',
          )
        )
          throw new FileContentError(
            'OCR_NOT_CONFIGURED',
            'PDF 中没有可靠的可读文本；扫描文档需要配置 OCR 模型。',
          );
        if (document.type === 'xlsx' || document.type === 'ods')
          return {
            ...textResult(''),
            ...spreadsheetContent(document.content, parameters),
          };
        const slides = pageSelection(parameters.ppt_slides, 'ppt_slides');
        if (slides) {
          if (!['pptx', 'odp'].includes(document.type))
            throw new FileContentError(
              'INVALID_FILE_PARAMETERS',
              'ppt_slides 仅适用于演示文稿。',
            );
          document.content = document.content.filter(
            (node) =>
              node.type === 'slide' &&
              includesPage(slides, node.metadata?.slideNumber ?? 0),
          );
          if (!document.content.length)
            throw new FileContentError(
              'INVALID_FILE_PARAMETERS',
              'ppt_slides 没有匹配的幻灯片。',
            );
        }
        // The generator omits these names/numbers by default. Preserve source boundaries.
        document.content = document.content.flatMap((node) => {
          const label =
            node.type === 'sheet'
              ? `Sheet: ${node.metadata?.sheetName ?? ''}`
              : node.type === 'slide'
                ? `Slide ${node.metadata?.slideNumber ?? ''}`
                : node.type === 'page'
                  ? `Page ${node.metadata?.pageNumber ?? ''}`
                  : undefined;
          return label ? [sectionHeading(label), node] : [node];
        });
        if (document.auxiliary?.headers?.length)
          document.content.unshift(
            sectionHeading('Headers'),
            ...document.auxiliary.headers,
          );
        if (document.auxiliary?.footers?.length)
          document.content.push(
            sectionHeading('Footers'),
            ...document.auxiliary.footers,
          );
        const { value, messages } = await document.to('md', {
          abortSignal: signal,
          generateIds: false,
          includeImages: 'none',
          // Markdown's default chart renderer omits chart data; retain its text.
          onNode: (node) => (node.type === 'chart' ? node.text : undefined),
        });
        signal.throwIfAborted();
        assertCompleteDocument(messages);
        if (metadata.kind === 'pdf' && !value.trim())
          throw new FileContentError(
            'OCR_NOT_CONFIGURED',
            'PDF 中没有可读取的文本；扫描文档需要配置 OCR 模型。',
          );
        return textResult(value);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof FileContentError) throw error;
        throw new FileContentError(
          'FILE_PARSE_FAILED',
          '文档解析失败，请检查文件是否损坏、加密或超过解压安全限制。',
        );
      }
    }
    if (legacyOfficeExtensions.has(extension))
      throw new FileContentError(
        'FILE_TYPE_UNSUPPORTED',
        '请将旧版 Office 文件转换为 DOCX、XLSX、PPTX 或 PDF 后再读取。',
      );
    try {
      const text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(data);
      // eslint-disable-next-line no-control-regex -- Binary controls are not document text.
      if (/[\u0000-\u0008\u000e-\u001f]/.test(text))
        throw new Error('Binary input');
      return textResult(
        text,
        ['.md', '.markdown'].includes(extension) ? 'markdown' : 'text',
      );
    } catch {
      throw new FileContentError(
        'FILE_TYPE_UNSUPPORTED',
        '无法解析该二进制文件，请转换为文本、图片、PDF 或 Office 文档。',
      );
    }
  });
}
