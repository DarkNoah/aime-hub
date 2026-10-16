import type { DataSource, EntitySchema, MigrationInterface } from 'typeorm';
import type { Hono } from 'hono';
import type { BaseAgent } from '@aime/shared/agents';
import type { Tool } from '@mastra/core/tools';
// Mastra registries accept heterogeneous input/output schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginTool = Tool<any, any>;
import type { PluginConfig, PluginManifest } from './index.js';

export type PluginHttpEnv = { Variables: { userId: string; isAdmin: boolean } };
export interface PluginRuntimeContext {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly paths: {
    readonly applicationRoot: string;
    readonly workspaceRoot: string;
    /** Installed source/assets, separate from persistent plugin data. */
    readonly pluginRoot: string;
    readonly pluginWorkspace: string | null;
  };
  /** Lazily creates the declared workspace. Throws if workspace was not declared. */
  ensureWorkspace(): Promise<string>;
}
export interface PluginContext {
  readonly id: string;
  readonly runtime: PluginRuntimeContext;
  /** Shared, initialized host connection. Do not initialize or destroy it. */
  readonly database: DataSource;
  /** Checks persisted state and local readiness. Not available until onEnable completes. */
  assertEnabled(): Promise<void>;
}
export interface PluginServer {
  /** Mounted at /api/plugins/{id}; session, origin and enabled guards belong to the host. */
  api?: Hono<PluginHttpEnv>;
  /** IDs must start with plugin:{id}:. Model null inherits host model settings. */
  agents?: BaseAgent[];
  /** IDs must start with plugin_{id with hyphens replaced by underscores}_. */
  tools?: PluginTool[];
  /** Starts this process's resources on activation/restart. Must be retry-safe. */
  onEnable?: (context: PluginLifecycleContext) => void | Promise<void>;
  /** Stops and drains resources, including partial onEnable failures. Must be retry-safe. */
  onDisable?: (context: PluginLifecycleContext) => void | Promise<void>;
  /** Final process cleanup, after onDisable (even if it fails). Setup must be side-effect free. */
  dispose?: () => Promise<void>;
}
export interface PluginLifecycleContext {
  /** Validated activation snapshot. onDisable receives the same values as its onEnable. */
  readonly config: PluginConfig;
}
export interface PluginDatabase {
  entities: EntitySchema[];
  /** Names are stable identities. Never edit an already released migration. */
  migrations: (new () => MigrationInterface)[];
}
export interface InstalledPlugin {
  manifest: PluginManifest;
  database: PluginDatabase;
  createServer(context: PluginContext): PluginServer;
}
