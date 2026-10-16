import { z } from 'zod';
import {
  pluginConfigFieldsSchema,
  type PluginConfiguration,
} from './config.js';
export * from './config.js';

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
  /** Administrator form; values are stored separately and never included in public manifests. */
  configFields: pluginConfigFieldsSchema,
  /** Request persistent storage at <WORKSPACE_ROOT>/plugins/<id>. */
  workspace: z.boolean().optional(),
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
  /** Available in this process only after onEnable succeeds and dependencies are ready. */
  enabled: boolean;
  /** Administrator's persisted choice, preserved across process shutdown/restart. */
  desiredEnabled: boolean;
  ready: boolean;
  installedVersion: string | null;
  reason: string | null;
};

export interface PluginConfigSaveResult {
  plugin: PluginStatus;
  configuration: PluginConfiguration;
  /** False means saved successfully but runtime restoration/cleanup needs attention. */
  applied: boolean;
}
