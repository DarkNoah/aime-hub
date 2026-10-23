import { extname } from 'node:path';
import { MDocument } from '@mastra/rag';
import { parseFileContent } from '../files/content/parse.js';
import { readWebPage } from '../../mastra/web/page.js';
import {
  knowledgeFileAccept,
  knowledgeImageFileAccept,
  maxKnowledgeFileBytes,
  type KnowledgeSource,
} from '@aime/shared/knowledge';
import { ThreadError } from '../threads/errors.js';
import { inspectImageFile } from '../files/binary-file.js';

const imageExtensions = new Set(knowledgeImageFileAccept.split(','));

export function validateKnowledgeFile(name: string, data: Buffer) {
  if (!knowledgeFileAccept.split(',').includes(extname(name).toLowerCase()))
    throw new ThreadError('KNOWLEDGE_FILE_TYPE', 400);
  if (!data.length || data.length > maxKnowledgeFileBytes)
    throw new ThreadError('KNOWLEDGE_TOO_LARGE', 413);
  if (imageExtensions.has(extname(name).toLowerCase())) {
    try {
      const image = inspectImageFile(data, name);
      if (!imageExtensions.has(extname(image.fileName)))
        throw new Error('Unsupported knowledge image');
      return image;
    } catch {
      throw new ThreadError('KNOWLEDGE_FILE_TYPE', 400);
    }
  }
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
    const image = validateKnowledgeFile(fileName, source.sourceData);
    const ext = extname(fileName).toLowerCase();
    if (image) {
      // One image is one vector. This label is for display, never text embedding.
      const content = `[Image: ${source.name}]`;
      return { content, texts: [content], inputType: 'image' as const };
    } else if (ext === '.txt' || ext === '.json') {
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
      const parsed = await parseFileContent(
        { data: source.sourceData, fileName },
        {
          signal: AbortSignal.timeout(30_000),
          parameters: { excel_rows: 'all' },
        },
      );
      if (parsed.type !== 'text')
        throw new ThreadError('KNOWLEDGE_FILE_TYPE', 400);
      content = parsed.text;
      format = parsed.format;
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
