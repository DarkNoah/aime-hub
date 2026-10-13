import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_TOOLS,
  type LSPConfig,
  type WorkspaceFilesystem,
  type WorkspaceToolHooks,
} from '@mastra/core/workspace';

const require = createRequire(import.meta.url);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function workspaceLspConfig(root: string): LSPConfig {
  return {
    root,
    maxOpenClients: 4,
    // Resolve the bundled server independently of cwd and the inspected project's
    // dependencies, in both tsx development and the bundled production server.
    binaryOverrides: {
      typescript: `${quote(process.execPath)} ${quote(require.resolve('typescript-language-server/lib/cli.mjs'))} --stdio`,
    },
    searchPaths: [dirname(fileURLToPath(import.meta.url))],
  };
}

function inside(root: string, path: string) {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function workspaceLspHooks(
  root: string,
  filesystem: WorkspaceFilesystem,
): WorkspaceToolHooks {
  return {
    async beforeToolCall({ workspaceToolName, input }) {
      if (workspaceToolName !== WORKSPACE_TOOLS.LSP.LSP_INSPECT) return;
      const path =
        input && typeof input === 'object' && 'path' in input
          ? input.path
          : undefined;
      const denied = {
        proceed: false as const,
        output: {
          error: 'LSP inspection requires a file inside the current workspace.',
        },
      };
      if (typeof path !== 'string' || !path.trim() || path.includes('\0'))
        return denied;
      // Match Mastra's filesystem/mount resolution, but reject its unrestricted
      // host-path fallback and symlinks escaping the current workspace.
      const absolute =
        filesystem.resolveAbsolutePath?.(path) ?? resolve(root, path);
      if (!inside(root, absolute)) return denied;
      try {
        const [canonicalRoot, canonicalFile] = await Promise.all([
          realpath(root),
          realpath(absolute),
        ]);
        if (!inside(canonicalRoot, canonicalFile)) return denied;
      } catch {
        return {
          proceed: false,
          output: { error: 'LSP inspection file is unavailable.' },
        };
      }
    },
  };
}
