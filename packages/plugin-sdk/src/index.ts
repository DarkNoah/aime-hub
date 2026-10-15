import { z } from 'zod';

/** Increment this when the host breaks the plugin contract. */
export const PLUGIN_API_VERSION = 1;
export const pluginManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  apiVersion: z.literal(PLUGIN_API_VERSION),
  /** Build/discovery switch. False excludes all plugin entries; not the admin runtime switch. */
  enabled: z.boolean().default(true),
  // Dependencies refer to other installed plugin IDs, not npm packages.
  dependencies: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).default([]),
  pages: z
    .array(
      z.strictObject({
        path: z
          .string()
          .regex(
            /^(?:[a-z][a-z0-9-]*|:[a-zA-Z][a-zA-Z0-9]*)(?:\/(?:[a-z][a-z0-9-]*|:[a-zA-Z][a-zA-Z0-9]*))*$|^$/,
          ),
        title: z.string().min(1).max(100),
        access: z.enum(['session', 'admin']).default('session'),
        navigation: z.boolean().default(false),
      }),
    )
    .default([]),
  /** Contributions to the chat workspace's right sidebar. */
  rightSidebar: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        title: z.string().trim().min(1).max(100),
        access: z.enum(['session', 'admin']).default('session'),
        icon: z.enum(['puzzle', 'notebook', 'list', 'chart']).default('puzzle'),
      }),
    )
    .default([]),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginStatus = Omit<PluginManifest, 'enabled'> & {
  /** Runtime activation stored in the database, independent of manifest.enabled. */
  enabled: boolean;
  ready: boolean;
  installedVersion: string | null;
  reason: string | null;
};
