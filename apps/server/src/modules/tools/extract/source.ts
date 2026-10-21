import { basename, extname } from 'node:path';
import type { WorkspaceFilesystem } from '@mastra/core/workspace';
import type { MessageInput } from '@mastra/core/agent/message-list';
import type { OcrModel } from '../../../mastra/providers/ocr-model.js';
import { assertWorkspacePath } from '../../files/workspace-access.js';
import {
  inspectImageFile,
  maxBinaryFileBytes,
} from '../../files/binary-file.js';
import { extractWebContent } from '../../../mastra/web/page.js';
import { requestWebResource, webUrl } from '../../../mastra/web/request.js';

export class ExtractionError extends Error {}

export type ExtractionSourceDependencies = {
  resolveOcr?: () => Promise<{ model: OcrModel }>;
  transcribe?: (data: Buffer, signal: AbortSignal) => Promise<string>;
};
const imageExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.jp2',
]);
const officeExtensions = new Set([
  '.docx',
  '.pptx',
  '.xlsx',
  '.odt',
  '.odp',
  '.ods',
  '.odg',
  '.rtf',
  '.epub',
]);
const mediaExtensions = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.aac',
  '.flac',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
]);
const mimeExtensions: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'text/html': '.html',
};

function checkSize(size: number) {
  if (!size) throw new ExtractionError('文件内容为空。');
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBinaryFileBytes)
    throw new ExtractionError('文件超过 200 MB，请拆分后抽取。');
}

async function loadSource(
  source: string,
  filesystem: WorkspaceFilesystem | undefined,
  signal: AbortSignal,
) {
  if (/^https?:\/\//i.test(source)) {
    let url = webUrl(source).href;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const result = await requestWebResource(url, {
        signal,
        maxBytes: maxBinaryFileBytes,
      });
      if (
        [301, 302, 303, 307, 308].includes(result.status) &&
        result.headers.location
      ) {
        url = webUrl(new URL(result.headers.location, url).href).href;
        continue;
      }
      if (result.status < 200 || result.status >= 300)
        throw new ExtractionError('无法下载来源文件，请检查 URL。');
      checkSize(result.body.length);
      const mime = result.headers['content-type']
        ?.split(';')[0]
        ?.trim()
        .toLowerCase();
      const name = basename(new URL(url).pathname) || 'download';
      const extension =
        mimeExtensions[mime ?? ''] ?? extname(name).toLowerCase();
      return {
        data: result.body,
        name:
          extension && !name.toLowerCase().endsWith(extension)
            ? `${name}${extension}`
            : name,
        extension,
        url,
      };
    }
    throw new ExtractionError('来源 URL 重定向次数过多。');
  }
  if (!filesystem) throw new ExtractionError('当前会话没有可用的文件工作区。');
  const path = source.replace(/^\/(?=\.uploads\/)/, '');
  if (!path || path.includes('\0'))
    throw new ExtractionError('请提供有效的工作区文件路径。');
  await assertWorkspacePath(filesystem, path);
  const before = await filesystem.stat(path);
  if (before.type !== 'file') throw new ExtractionError('来源路径必须是文件。');
  checkSize(before.size);
  signal.throwIfAborted();
  const data = Buffer.from(await filesystem.readFile(path));
  checkSize(data.length);
  const after = await filesystem.stat(path);
  if (
    before.size !== data.length ||
    before.size !== after.size ||
    before.modifiedAt.getTime() !== after.modifiedAt.getTime()
  )
    throw new ExtractionError('读取过程中文件发生变化，请保存完成后重试。');
  return {
    data,
    name: basename(path),
    extension: extname(path).toLowerCase(),
    url: undefined,
  };
}

function textInput(text: string): MessageInput[] {
  if (!text.trim())
    throw new ExtractionError(
      '文件中没有可抽取的内容；扫描文档需要配置 OCR 模型。',
    );
  // Never silently extract from a truncated source.
  if (text.length > 1_000_000)
    throw new ExtractionError(
      '解析内容超过 1,000,000 字符，请拆分文件后抽取。',
    );
  return [{ role: 'user', content: text }];
}

function mediaInput(
  data: Buffer,
  mimeType: string,
  name: string,
): MessageInput[] {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'file',
          data: data.toString('base64'),
          mimeType,
          filename: name,
        },
      ],
    },
  ];
}

export async function readExtractionSource(
  source: string,
  filesystem: WorkspaceFilesystem | undefined,
  modalities: readonly string[],
  signal: AbortSignal,
  dependencies: ExtractionSourceDependencies,
): Promise<MessageInput[]> {
  const { data, name, extension, url } = await loadSource(
    source,
    filesystem,
    signal,
  );
  signal.throwIfAborted();
  if (imageExtensions.has(extension)) {
    const image = inspectImageFile(data, name);
    if (
      modalities.includes('image') &&
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
        image.mimeType,
      )
    )
      return mediaInput(data, image.mimeType, image.fileName);
    if (!dependencies.resolveOcr)
      throw new ExtractionError(
        '图片抽取需要支持图片输入的语言模型，或配置默认 OCR 模型。BMP、TIFF、JP2 请配置 OCR 或先转换为 PNG/JPEG。',
      );
    const { model } = await dependencies.resolveOcr();
    signal.throwIfAborted();
    return textInput(
      (
        await model.doOCR({
          input: { data, fileName: image.fileName },
          abortSignal: signal,
        })
      ).markdown,
    );
  }
  if (extension === '.pdf') {
    if (!data.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw new ExtractionError('文件不是有效的 PDF。');
    if (modalities.includes('pdf'))
      return mediaInput(data, 'application/pdf', name);
    if (dependencies.resolveOcr) {
      // Missing OCR is allowed for text PDFs; configured but failing OCR must surface an error.
      let resolved:
        | Awaited<
            ReturnType<NonNullable<ExtractionSourceDependencies['resolveOcr']>>
          >
        | undefined;
      try {
        resolved = await dependencies.resolveOcr();
      } catch (error) {
        if (!(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'OCR_NOT_CONFIGURED'
        ))
          throw error;
      }
      signal.throwIfAborted();
      if (resolved)
        return textInput(
          (
            await resolved.model.doOCR({
              input: { data, fileName: name },
              abortSignal: signal,
            })
          ).markdown,
        );
    }
  }
  if (officeExtensions.has(extension) || extension === '.pdf') {
    const { OfficeParser } = await import('officeparser');
    const document = await OfficeParser.parseOffice(data, {
      fileType: extension.slice(1) as import('officeparser').SupportedFileType,
      abortSignal: signal,
      extractAttachments: false,
      includeRawContent: false,
      ocr: false,
      ignorePageGeometry: true,
      decompressionLimits: {
        maxUncompressedBytes: 64 * 1024 * 1024,
        maxZipEntries: 5000,
      },
    });
    signal.throwIfAborted();
    return textInput(
      (await document.to('text', { includeImages: 'none' })).value,
    );
  }
  if (mediaExtensions.has(extension)) {
    if (!dependencies.transcribe)
      throw new ExtractionError(
        '音视频抽取需要配置默认 ASR 模型；视频抽取仅分析音轨。',
      );
    return textInput(await dependencies.transcribe(data, signal));
  }
  if (['.doc', '.xls', '.ppt'].includes(extension))
    throw new ExtractionError(
      '请将旧版 Office 文件转换为 DOCX、XLSX、PPTX 或 PDF 后再抽取。',
    );
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    // eslint-disable-next-line no-control-regex -- Binary controls are not readable document content.
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text))
      throw new Error('Binary input');
  } catch {
    throw new ExtractionError(
      '无法解析该二进制文件，请转换为文本、图片、PDF 或 Office 文档。',
    );
  }
  if (extension === '.html' || extension === '.htm')
    text = (await extractWebContent(text, url ?? 'https://document.invalid/'))
      .content;
  return textInput(text);
}
