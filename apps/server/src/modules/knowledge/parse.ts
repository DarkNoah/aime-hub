import { extname } from 'node:path';
import { MDocument } from '@mastra/rag';
import { OfficeParser, type SupportedFileType } from 'officeparser';
import { readWebPage } from '../../mastra/web/page.js';
import {
  knowledgeFileAccept,
  maxKnowledgeFileBytes,
  type KnowledgeSource,
} from '@aime/shared/knowledge';
import { ThreadError } from '../threads/errors.js';

export function validateKnowledgeFile(name: string, data: Buffer) {
  if (!knowledgeFileAccept.split(',').includes(extname(name).toLowerCase()))
    throw new ThreadError('KNOWLEDGE_FILE_TYPE', 400);
  if (!data.length || data.length > maxKnowledgeFileBytes)
    throw new ThreadError('KNOWLEDGE_TOO_LARGE', 413);
}

export async function parseKnowledgeSource(source: {
  sourceType: KnowledgeSource['type'];
  name: string;
  sourceName?: string | null;
  sourceUrl: string | null;
  sourceData: Buffer;
}) {
  let content: string;
  let format = 'text';
  if (source.sourceType === 'url') {
    const page = await readWebPage(source.sourceUrl!, {
      signal: AbortSignal.timeout(30_000),
      maxBytes: maxKnowledgeFileBytes,
    });
    content = page.content;
    format = 'markdown';
  } else if (source.sourceType === 'text') {
    content = source.sourceData.toString('utf8');
    format = 'markdown';
  } else {
    const fileName = source.sourceName ?? source.name;
    validateKnowledgeFile(fileName, source.sourceData);
    const ext = extname(fileName).toLowerCase();
    if (ext === '.txt' || ext === '.json') {
      content = new TextDecoder('utf-8', { fatal: true }).decode(
        source.sourceData,
      );
      if (content.includes('\0'))
        throw new ThreadError('KNOWLEDGE_FILE_TYPE', 400);
      if (ext === '.json') {
        content = JSON.stringify(JSON.parse(content), null, 2);
        format = 'json';
      }
    } else {
      const fileType = (
        ext === '.markdown' ? 'md' : ext === '.htm' ? 'html' : ext.slice(1)
      ) as SupportedFileType;
      const document = await OfficeParser.parseOffice(source.sourceData, {
        fileType,
        abortSignal: AbortSignal.timeout(30_000),
        extractAttachments: false,
        includeRawContent: false,
        ocr: false,
        ignorePageGeometry: true,
        decompressionLimits: {
          maxUncompressedBytes: 64 * 1024 * 1024,
          maxZipEntries: 5000,
        },
      });
      content = (
        await document.to('text', {
          textConfig: { preserveLayout: false },
          includeImages: 'none',
        })
      ).value;
    }
  }
  content = content.trim();
  if (!content) throw new ThreadError('KNOWLEDGE_EMPTY_CONTENT', 400);
  if (content.length > 1_000_000)
    throw new ThreadError('KNOWLEDGE_TOO_LARGE', 413);
  const doc =
    format === 'markdown'
      ? MDocument.fromMarkdown(content)
      : format === 'json'
        ? MDocument.fromJSON(content)
        : MDocument.fromText(content);
  const chunks = await doc.chunk({
    strategy: 'recursive',
    maxSize: 1000,
    overlap: 150,
    separators: ['\n\n', '\n', '。', '！', '？', '. ', ' ', ''],
  });
  const texts = chunks.map((chunk) => chunk.text.trim()).filter(Boolean);
  if (!texts.length) throw new ThreadError('KNOWLEDGE_EMPTY_CONTENT', 400);
  if (texts.length > 2000) throw new ThreadError('KNOWLEDGE_TOO_LARGE', 413);
  return { content, texts };
}
