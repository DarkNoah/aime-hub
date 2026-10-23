import { basename, posix } from 'node:path';
import {
  LocalFilesystem,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
import { withAbortSignal } from '../../../lib/abort.js';
import { requestWebResource, webUrl } from '../../../mastra/web/request.js';
import { assertWorkspacePath } from '../workspace-access.js';
import { maxBinaryFileBytes } from '../binary-file.js';
import { fileNameForMimeType } from './formats.js';
import { parseFileContent, validateFileContentSize } from './parse.js';
import type { FileContentDependencies, FileContentOptions } from './types.js';
import { FileContentError } from './types.js';

/** Read through the workspace provider or the existing bounded HTTP client. */
export async function readFileContent(
  input: { path: string } & Omit<FileContentOptions, 'signal'>,
  context: FileContentDependencies & {
    filesystem?: WorkspaceFilesystem;
    signal?: AbortSignal;
  } = {},
) {
  const { path: source, ...options } = input;
  const { filesystem, signal: inputSignal, ...dependencies } = context;
  const signal = inputSignal ?? new AbortController().signal;
  return withAbortSignal(signal, async () => {
    if (/^https?:\/\//i.test(source)) {
      let url = webUrl(source).href;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const result = await requestWebResource(url, {
          signal,
          maxBytes: maxBinaryFileBytes,
        });
        signal.throwIfAborted();
        if (
          [301, 302, 303, 307, 308].includes(result.status) &&
          result.headers.location
        ) {
          url = webUrl(new URL(result.headers.location, url).href).href;
          continue;
        }
        if (result.status < 200 || result.status >= 300)
          throw new FileContentError(
            'FILE_DOWNLOAD_FAILED',
            '无法下载来源文件，请检查 URL。',
          );
        const fileName = fileNameForMimeType(
          basename(new URL(url).pathname) || 'download',
          result.headers['content-type'],
        );
        return {
          ...(await parseFileContent(
            { data: result.body, fileName },
            { ...options, signal },
            dependencies,
          )),
          path: url,
        };
      }
      throw new FileContentError(
        'FILE_DOWNLOAD_FAILED',
        '来源 URL 重定向次数过多。',
      );
    }
    if (!filesystem)
      throw new FileContentError(
        'WORKSPACE_UNAVAILABLE',
        '当前会话没有可用的文件工作区。',
      );
    const inputPath = source.replace(/^\/(?=\.uploads\/)/, '');
    if (!inputPath || inputPath.includes('\0'))
      throw new FileContentError(
        'FILE_INVALID_PATH',
        '请提供有效的工作区文件路径。',
      );
    await assertWorkspacePath(filesystem, inputPath);
    const before = await filesystem.stat(inputPath);
    if (before.type !== 'file')
      throw new FileContentError('FILE_NOT_FILE', '来源路径必须是文件。');
    validateFileContentSize(before.size, true);
    signal.throwIfAborted();
    const data = Buffer.from(await filesystem.readFile(inputPath));
    validateFileContentSize(data.length, true);
    signal.throwIfAborted();
    const after = await filesystem.stat(inputPath);
    if (
      before.size !== data.length ||
      before.size !== after.size ||
      before.modifiedAt.getTime() !== after.modifiedAt.getTime()
    )
      throw new FileContentError(
        'FILE_CHANGED',
        '读取过程中文件发生变化，请保存完成后重试。',
      );
    const path =
      filesystem instanceof LocalFilesystem
        ? before.path
        : posix.normalize(inputPath).replace(/^\//, '');
    return {
      ...(await parseFileContent(
        { data, fileName: basename(inputPath) },
        { ...options, signal },
        dependencies,
      )),
      path,
    };
  });
}
