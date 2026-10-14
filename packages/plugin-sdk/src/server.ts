import type { DataSource, EntitySchema, MigrationInterface } from 'typeorm';
import type { Hono } from 'hono';
import type { BaseAgent } from '@aime/shared/agents';
import type { Tool } from '@mastra/core/tools';
// Mastra registries accept heterogeneous input/output schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginTool = Tool<any, any>;
import type { PluginManifest } from './index.js';

export type PluginHttpEnv = { Variables: { userId: string; isAdmin: boolean } };
export interface PluginContext {
  readonly id: string;
  /** Shared, initialized host connection. Do not initialize or destroy it. */
  readonly database: DataSource;
  /** Rechecks persisted state; use at execution boundaries, never trust a cached flag. */
  assertEnabled(): Promise<void>;
}
export interface PluginServer {
  /** Mounted at /api/plugins/{id}; session, origin and enabled guards belong to the host. */
  api?: Hono<PluginHttpEnv>;
  /** IDs must start with plugin:{id}:. Model null inherits host model settings. */
  agents?: BaseAgent[];
  /** IDs must start with plugin_{id with hyphens replaced by underscores}_. */
  tools?: PluginTool[];
  /** Called at server shutdown; setup must not start background work. */
  dispose?: () => Promise<void>;
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
