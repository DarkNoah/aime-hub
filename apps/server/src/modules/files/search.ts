import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import glob from 'fast-glob';
import type { FileSearch } from '@aime/shared/files';
import { filePath } from './paths.js';
import { previewFile } from './service.js';

const ignored = new Set([
  '.git',
  'node_modules',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
]);
const MAX_MATCHES = 200;

async function ripgrep(
  root: string,
  files: string[],
  query: string,
  signal?: AbortSignal,
) {
  const binary = await import('@vscode/ripgrep')
    .then((module) => module.rgPath)
    .catch(() => null);
  if (!binary)
    throw Object.assign(new Error('Bundled ripgrep unavailable'), {
      code: 'ENOENT',
    });
  return new Promise<FileSearch>((resolve, reject) => {
    const result: FileSearch = { matches: [], truncated: false };
    // Explicit validated relative paths, no shell, no user/config-controlled flags.
    const child = spawn(
      binary,
      [
        '--no-config',
        '--json',
        '--fixed-strings',
        '--ignore-case',
        '--max-count',
        '201',
        '--max-filesize',
        '1M',
        '--',
        query,
        ...files.map((path) => `./${path}`),
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let buffer = '';
    let bytes = 0;
    let pending: FileSearch['matches'] = [];
    const stop = () => {
      result.truncated = true;
      child.kill();
    };
    const timer = setTimeout(stop, 3000);
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', reject);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) {
        stop();
        return;
      }
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const event = JSON.parse(line);
        if (event.type === 'begin') pending = [];
        if (event.type === 'end') {
          // rg can emit matches before detecting a later NUL byte in the file.
          if (event.data.binary_offset === null)
            result.matches.push(...pending);
          pending = [];
          if (result.matches.length >= MAX_MATCHES) {
            result.matches = result.matches.slice(0, MAX_MATCHES);
            stop();
            return;
          }
        }
        if (event.type !== 'match' || !event.data.path.text) continue;
        const path = event.data.path.text.replace(/^\.\//, '');
        pending.push({
          name: path.split('/').at(-1)!,
          path,
          kind: 'file',
          line: event.data.line_number,
          text: (event.data.lines.text ?? '').trimEnd().slice(0, 500),
        });
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (code && code > 1 && !result.truncated)
        reject(new Error('File search failed'));
      else resolve(result);
    });
    if (signal?.aborted) stop();
  });
}

export async function searchFiles(
  root: string,
  query: string,
  signal?: AbortSignal,
): Promise<FileSearch> {
  await filePath(root, '', true);
  const result: FileSearch = { matches: [], truncated: false };
  const files: string[] = [];
  const named: FileSearch['matches'] = [];
  const finish = (): FileSearch => {
    const contentPaths = new Set(result.matches.map((match) => match.path));
    const matches = [
      ...named.filter((match) => !contentPaths.has(match.path)),
      ...result.matches,
    ].sort(
      (a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0),
    );
    return {
      matches: matches.slice(0, MAX_MATCHES),
      truncated: result.truncated || matches.length > MAX_MATCHES,
    };
  };
  const needle = query.toLocaleLowerCase();
  const deadline = Date.now() + 5000;
  let visited = 0;
  let bytes = 0;
  const stream = glob.stream('**/*', {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    deep: 20,
    concurrency: 4,
    ignore: [...ignored].map((name) => `**/${name}/**`),
  }) as Readable;
  let stopped = false;
  const stop = () => {
    stopped = true;
    result.truncated = true;
    stream.destroy();
  };
  const timer = setTimeout(stop, 5000);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    for await (const value of stream) {
      const path = String(value);
      if (
        ++visited > 10000 ||
        files.length >= 1000 ||
        signal?.aborted ||
        Date.now() > deadline
      ) {
        stop();
        break;
      }
      const info = await filePath(root, path)
        .then((absolute) => lstat(absolute))
        .catch(() => null);
      if (!info?.isFile()) continue;
      const name = path.split('/').at(-1)!;
      if (name.toLocaleLowerCase().includes(needle)) {
        if (named.length < MAX_MATCHES)
          named.push({ path, name, kind: 'file' });
        else result.truncated = true;
      }
      if (info.size > 1024 * 1024 || bytes + info.size > 32 * 1024 * 1024) {
        result.truncated = true;
        continue;
      }
      files.push(path);
      bytes += info.size;
    }
  } catch (error) {
    if (!stopped) throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    stream.destroy();
  }
  if (!files.length || signal?.aborted) return finish();
  try {
    for (let offset = 0; offset < files.length; offset += 80) {
      if (signal?.aborted || Date.now() > deadline + 5000) {
        result.truncated = true;
        return finish();
      }
      const found = await ripgrep(
        root,
        files.slice(offset, offset + 80),
        query,
        signal,
      );
      result.matches.push(...found.matches);
      result.truncated ||= found.truncated;
      if (result.matches.length >= MAX_MATCHES) {
        result.truncated = true;
        return finish();
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Deployments without rg still support the same literal, case-insensitive search.
    for (const path of files) {
      if (signal?.aborted || Date.now() > deadline + 5000) {
        result.truncated = true;
        break;
      }
      const preview = await previewFile(root, path).catch(() => null);
      if (preview?.kind !== 'text') continue;
      result.truncated ||= !!preview.truncated;
      const lines = preview.text!.split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].toLocaleLowerCase().includes(needle))
          result.matches.push({
            path,
            name: path.split('/').at(-1)!,
            kind: 'file',
            line: index + 1,
            text: lines[index].slice(0, 500),
          });
        if (result.matches.length >= MAX_MATCHES) {
          result.truncated = true;
          return finish();
        }
      }
    }
  }
  return finish();
}
