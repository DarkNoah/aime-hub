import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { ToolExecutionContext } from '@mastra/core/tools';
import {
  LocalFilesystem,
  resolveToolConfig,
  WORKSPACE_TOOLS,
} from '@mastra/core/workspace';
import ts from 'typescript';
import { z } from 'zod';

const encodings = z.enum([
  'utf8',
  'utf-8',
  'ascii',
  'latin1',
  'binary',
  'base64',
  'base64url',
  'hex',
  'utf16le',
  'utf-16le',
  'ucs2',
  'ucs-2',
]);
const filePath = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'));
const readInput = z.object({ path: filePath, encoding: encodings.nullish() });
const writeInput = z.object({
  path: filePath,
  data: z.union([z.string(), z.array(z.number().int().min(0).max(255))]),
  encoding: encodings.default('utf8'),
  flag: z.enum(['w', 'wx', 'a']),
});
const fsOperations = {
  readFile: WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  writeFile: WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  appendFile: WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  mkdir: WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
} as const;
const pathMethods = [
  'join',
  'resolve',
  'normalize',
  'dirname',
  'basename',
  'extname',
  'relative',
  'isAbsolute',
  'parse',
  'format',
] as const;

export type ExecModules = ReturnType<typeof createExecModules>;

async function canonicalPath(filename: string): Promise<string> {
  try {
    return await realpath(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const entry = await lstat(filename).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (entry?.isSymbolicLink())
      throw new Error('Cannot access a dangling workspace symlink');
    const parent = path.dirname(filename);
    if (parent === filename) throw error;
    return path.join(await canonicalPath(parent), path.basename(filename));
  }
}

async function assertLocalPath(filesystem: LocalFilesystem, filename: string) {
  if (!filesystem.contained) return;
  const absolute = filesystem.resolveAbsolutePath(filename);
  if (!absolute) throw new Error('File path is outside the workspace');
  // Some LocalFilesystem versions skip symlink checks under allowedPaths.
  // Check canonical targets, including parents of files that do not exist yet.
  const target = await canonicalPath(absolute);
  const roots = await Promise.all(
    [filesystem.basePath, ...filesystem.allowedPaths].map(canonicalPath),
  );
  if (
    !roots.some((root) => {
      const relative = path.relative(root, target);
      return (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    })
  )
    throw new Error('File path is outside the workspace');
}

/** Expose a small Node-compatible API through the same JSON-only VM boundary. */
export function createExecModules(context: ToolExecutionContext) {
  return {
    load(name: string): string {
      switch (name) {
        case 'fs':
        case 'node:fs':
          return `
            import promises from 'node:fs/promises';
            export { promises };
            const callback = (operation, args) => {
              const done = args.pop();
              if (typeof done !== 'function') throw new TypeError('Callback required; use fs.promises for await');
              operation(...args).then(value => done(null, value), error => done(error));
            };
            export const readFile = (...args) => callback(promises.readFile, args);
            export const writeFile = (...args) => callback(promises.writeFile, args);
            export const appendFile = (...args) => callback(promises.appendFile, args);
            export const mkdir = (...args) => callback(promises.mkdir, args);
            export default Object.freeze({ promises, readFile, writeFile, appendFile, mkdir });
          `;
        case 'fs/promises':
        case 'node:fs/promises':
          return `
            const call = globalThis.__execModuleCall;
            const options = (value, allowed) => {
              if (typeof value === 'string') return { encoding: value };
              if (value == null) return {};
              if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid fs options');
              for (const key of Object.keys(value)) {
                if (!allowed.includes(key)) throw new Error('Unsupported fs option: ' + key);
              }
              return value;
            };
            const data = value => {
              if (typeof value === 'string') return value;
              if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
              throw new TypeError('File data must be a string or typed array');
            };
            export async function readFile(path, value) {
              const result = await call('readFile', { path, ...options(value, ['encoding']) });
              return Array.isArray(result) ? new Uint8Array(result) : result;
            }
            export async function writeFile(path, value, config) {
              await call('writeFile', { path, data: data(value), flag: 'w', ...options(config, ['encoding', 'flag']) });
            }
            export async function appendFile(path, value, config) {
              await call('appendFile', { path, data: data(value), flag: 'a', ...options(config, ['encoding', 'flag']) });
            }
            export async function mkdir(path, config) {
              await call('mkdir', { path, ...options(config, ['recursive']) });
            }
            export default Object.freeze({ readFile, writeFile, appendFile, mkdir });
          `;
        case 'path':
        case 'node:path':
        case 'path/posix':
        case 'node:path/posix':
        case 'path/win32':
        case 'node:path/win32': {
          const style = name.endsWith('/win32')
            ? 'win32'
            : name.endsWith('/posix') || process.platform !== 'win32'
              ? 'posix'
              : 'win32';
          const source = (variant: 'posix' | 'win32') => `Object.freeze({
            sep: ${JSON.stringify(path[variant].sep)},
            delimiter: ${JSON.stringify(path[variant].delimiter)},
            ${pathMethods.map((method) => `${method}: (...args) => call('${variant}.${method}', args)`).join(',')}
          })`;
          return `
            const call = globalThis.__execModuleSync;
            export const posix = ${source('posix')};
            export const win32 = ${source('win32')};
            const api = ${style};
            ${['sep', 'delimiter', ...pathMethods].map((name) => `export const ${name} = api.${name};`).join('\n')}
            export default Object.freeze({ ...api, posix, win32 });
          `;
        }
        default:
          throw new Error(
            `Unsupported exec import: ${name}. Available: node:fs, node:fs/promises, node:path (including posix/win32).`,
          );
      }
    },
    sync(operation: string, input: unknown): unknown {
      const [variant, method] = operation.split('.');
      if (
        !['posix', 'win32'].includes(variant) ||
        !pathMethods.includes(method as (typeof pathMethods)[number]) ||
        !Array.isArray(input)
      )
        throw new Error(`Unknown module operation: ${operation}`);
      const api = variant === 'win32' ? path.win32 : path.posix;
      // Resolve against the conversation workspace, never the server's cwd.
      const root = context.workspace?.filesystem?.basePath ?? '/';
      const base =
        variant === 'win32' && !/^(?:[a-z]:|\\\\)/i.test(root)
          ? `C:${root.replaceAll('/', '\\')}`
          : root;
      if (
        (method === 'resolve' || method === 'relative') &&
        variant === 'win32' &&
        input.some(
          (value) =>
            typeof value === 'string' && /^[a-z]:(?![/\\])/i.test(value),
        )
      )
        throw new Error(
          'Drive-relative Windows paths are unsupported; use an absolute path',
        );
      const args =
        method === 'resolve'
          ? [base, ...input]
          : method === 'relative'
            ? input.map((value) => api.resolve(base, z.string().parse(value)))
            : input;
      const invoke = api[method as (typeof pathMethods)[number]] as (
        ...args: unknown[]
      ) => unknown;
      return invoke(...args);
    },
    async dispatch(operation: string, input: unknown): Promise<unknown> {
      context.abortSignal?.throwIfAborted();
      if (!Object.hasOwn(fsOperations, operation))
        throw new Error(`Unknown filesystem operation: ${operation}`);
      const workspace = context.workspace;
      const filesystem = workspace?.filesystem;
      if (!workspace || !filesystem)
        throw new Error(
          'Filesystem imports require an active workspace filesystem',
        );
      const workspaceToolName =
        fsOperations[operation as keyof typeof fsOperations];
      const writing = operation !== 'readFile';
      const config = await resolveToolConfig(
        workspace.getToolsConfig(),
        workspaceToolName,
        {
          workspace,
          requestContext: context.requestContext?.all ?? {},
        },
      );
      if (!config.enabled || (writing && filesystem.readOnly))
        throw new Error(
          `Filesystem operation unavailable: ${operation} (disabled or read-only)`,
        );
      const args =
        operation === 'readFile'
          ? readInput.parse(input)
          : operation === 'mkdir'
            ? z
                .object({
                  path: filePath,
                  recursive: z.boolean().default(false),
                })
                .parse(input)
            : writeInput.parse(input);
      // Policy functions and hooks expect workspace-tool inputs, including content/overwrite.
      const writeArgs =
        operation === 'writeFile' || operation === 'appendFile'
          ? writeInput.parse(args)
          : undefined;
      const toolInput = writeArgs
        ? {
            path: writeArgs.path,
            content: (typeof writeArgs.data === 'string'
              ? Buffer.from(writeArgs.data, writeArgs.encoding)
              : Buffer.from(writeArgs.data)
            ).toString('utf8'),
            overwrite: writeArgs.flag !== 'wx',
          }
        : args;
      const policyContext = {
        workspace,
        requestContext: context.requestContext?.all ?? {},
        args: toolInput,
      };
      const approval =
        typeof config.requireApproval === 'function'
          ? await config.requireApproval(policyContext)
          : config.requireApproval;
      if (approval)
        throw new Error(
          `${operation} requires a direct Agent call for approval`,
        );
      const readFirst =
        writing &&
        (typeof config.requireReadBeforeWrite === 'function'
          ? await config.requireReadBeforeWrite(policyContext)
          : config.requireReadBeforeWrite);
      if (readFirst)
        throw new Error(
          `${operation} requires read-before-write tracking; use the workspace tools`,
        );
      const hookContext = {
        toolName: config.name ?? workspaceToolName,
        workspaceToolName,
        input: toolInput,
        context,
      };
      const before = await config.hooks?.beforeToolCall?.(hookContext);
      if (before?.proceed === false)
        throw new Error(
          `Filesystem operation blocked by workspace hook: ${operation}`,
        );
      let output: unknown;
      try {
        context.abortSignal?.throwIfAborted();
        if (filesystem instanceof LocalFilesystem)
          await assertLocalPath(filesystem, args.path);
        context.abortSignal?.throwIfAborted();
        if (operation === 'readFile') {
          const { path: filename, encoding } = readInput.parse(args);
          // Bound host allocation as well as the JSON result passed back to WASM.
          if ((await filesystem.stat(filename)).size > 8 * 1024 * 1024)
            throw new Error('exec file read exceeds 8 MiB');
          context.abortSignal?.throwIfAborted();
          const content = await filesystem.readFile(filename);
          const bytes =
            typeof content === 'string' ? Buffer.from(content) : content;
          if (bytes.length > 8 * 1024 * 1024)
            throw new Error('exec file read exceeds 8 MiB');
          output = encoding ? bytes.toString(encoding) : Array.from(bytes);
        } else if (operation === 'mkdir') {
          const { path: directory, recursive } = args as {
            path: string;
            recursive: boolean;
          };
          await filesystem.mkdir(directory, { recursive });
        } else {
          const {
            path: filename,
            data,
            encoding,
            flag,
          } = writeInput.parse(args);
          if (operation === 'appendFile' && flag !== 'a')
            throw new Error('appendFile only supports flag "a"');
          const content =
            typeof data === 'string'
              ? Buffer.from(data, encoding)
              : Buffer.from(data);
          if (flag === 'a') await filesystem.appendFile(filename, content);
          else
            await filesystem.writeFile(filename, content, {
              overwrite: flag !== 'wx',
            });
        }
      } catch (error) {
        await config.hooks?.afterToolCall?.({ ...hookContext, error });
        throw error;
      }
      await config.hooks?.afterToolCall?.({ ...hookContext, output });
      return output;
    },
  };
}

/** Hoist static imports while preserving the existing function-body/return contract. */
export function execModuleSource(code: string) {
  const source = ts.createSourceFile(
    'exec.js',
    code,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.JS,
  );
  const imports: string[] = [];
  let body = '',
    offset = 0;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const start = statement.getStart(source),
      end = statement.end;
    imports.push(code.slice(start, end));
    body +=
      code.slice(offset, start) +
      code.slice(start, end).replace(/[^\r\n]/g, ' ');
    offset = end;
  }
  body += code.slice(offset);
  return `${imports.join('\n')}\nexport default (async () => {\n${body}\n})()`;
}
