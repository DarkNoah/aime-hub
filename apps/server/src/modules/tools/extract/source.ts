import type { WorkspaceFilesystem } from '@mastra/core/workspace';
import type { MessageInput } from '@mastra/core/agent/message-list';
import { readFileContent } from '../../files/content/source.js';
import type {
  FileContentDependencies,
  FileContentModel,
  FileContentParameters,
} from '../../files/content/types.js';

export class ExtractionError extends Error {}
export type ExtractionSourceDependencies = FileContentDependencies;

/** Model input/context policy, deliberately separate from complete file parsing. */
export async function readExtractionSource(
  source: string,
  filesystem: WorkspaceFilesystem | undefined,
  model: FileContentModel,
  signal: AbortSignal,
  dependencies: ExtractionSourceDependencies,
  parameters: FileContentParameters = {},
): Promise<MessageInput[]> {
  const result = await readFileContent(
    { path: source, model, parameters: { excel_rows: 'all', ...parameters } },
    { filesystem, signal, ...dependencies },
  );
  if (!result.text.trim() && !result.images?.length)
    throw new ExtractionError(
      '文件中没有可抽取的内容；扫描文档需要配置 OCR 模型。',
    );
  // Never silently extract fields from a clipped source. Other consumers can read it in full.
  if (result.text.length > 1_000_000)
    throw new ExtractionError(
      '解析内容超过 1,000,000 字符，请拆分文件后抽取。',
    );
  if (result.images?.length)
    return [
      {
        role: 'user',
        content: [
          ...(result.text
            ? [{ type: 'text' as const, text: result.text }]
            : []),
          ...result.images.map((image) => ({
            type: 'file' as const,
            data: image.data,
            mimeType: image.mimeType,
            filename: image.fileName,
          })),
        ],
      },
    ];
  return [{ role: 'user', content: result.text }];
}
