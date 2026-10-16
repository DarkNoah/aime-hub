import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { PluginManifest } from '@app/plugin-sdk';
import type { PluginRuntimeContext } from '@app/plugin-sdk/server';

export interface PluginRuntimeOptions {
  applicationRoot: string;
  workspaceRoot: string;
}

export function createPluginRuntime(
  manifest: Pick<PluginManifest, 'id' | 'workspace'>,
  options: PluginRuntimeOptions,
): PluginRuntimeContext {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(manifest.id))
    throw new Error('Invalid plugin ID');
  const applicationRoot = resolve(options.applicationRoot);
  const workspaceRoot = resolve(options.workspaceRoot);
  const pluginWorkspace = manifest.workspace
    ? resolve(workspaceRoot, 'plugins', manifest.id)
    : null;
  return Object.freeze({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    paths: Object.freeze({
      applicationRoot,
      workspaceRoot,
      pluginRoot: resolve(applicationRoot, 'plugins', manifest.id),
      pluginWorkspace,
    }),
    async ensureWorkspace() {
      if (!pluginWorkspace)
        throw new Error('Plugin must declare workspace: true');
      await mkdir(workspaceRoot, { recursive: true });
      const root = await realpath(workspaceRoot);
      for (const path of [resolve(workspaceRoot, 'plugins'), pluginWorkspace]) {
        await mkdir(path, { recursive: true });
        const location = relative(root, await realpath(path));
        if (
          (await lstat(path)).isSymbolicLink() ||
          location === '..' ||
          location.startsWith(`..${sep}`) ||
          isAbsolute(location)
        )
          throw new Error(
            'Plugin workspace must remain inside the configured workspace',
          );
      }
      return pluginWorkspace;
    },
  });
}
