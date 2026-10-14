import type { DataSource } from 'typeorm';
import type { BaseAgent } from '@aime/shared/agents';
import { agentInputSchema, agentIdSchema } from '@aime/shared/agents';
import { toolIdSchema, type ToolConfig } from '@aime/shared/tools';
import type { ToolsInput } from '@mastra/core/agent';
import type { PluginStatus } from '@app/plugin-sdk';
import type { InstalledPlugin, PluginServer } from '@app/plugin-sdk/server';

export class PluginError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
  ) {
    super(code);
  }
}
type Installation = { id: string; version: string; enabled: boolean };

/** Code is immutable for the lifetime of a process; activation is read from PostgreSQL. */
export class PluginService {
  private servers = new Map<string, PluginServer>();
  constructor(
    private readonly database: DataSource,
    readonly definitions: readonly InstalledPlugin[],
  ) {
    const ids = new Set<string>();
    for (const definition of definitions) {
      const { id } = definition.manifest;
      if (ids.has(id)) throw new Error(`Duplicate plugin ID: ${id}`);
      ids.add(id);
      const server = definition.createServer({
        id,
        database,
        assertEnabled: () => this.assertEnabled(id),
      });
      const agents = new Set<string>();
      for (const agent of server.agents ?? []) {
        agentIdSchema.parse(agent.id);
        agentInputSchema.parse(
          Object.fromEntries(
            Object.entries(agent).filter(
              ([key]) => key !== 'id' && key !== 'source',
            ),
          ),
        );
        if (
          agent.source !== 'code' ||
          !agent.id.startsWith(`plugin:${id}:`) ||
          agents.has(agent.id)
        )
          throw new Error(`Invalid plugin Agent ID: ${agent.id}`);
        agents.add(agent.id);
      }
      const tools = new Set<string>();
      for (const tool of server.tools ?? []) {
        toolIdSchema.parse(tool.id);
        if (
          !tool.id.startsWith(`plugin_${id.replaceAll('-', '_')}_`) ||
          tools.has(tool.id)
        )
          throw new Error(`Invalid plugin Tool ID: ${tool.id}`);
        tools.add(tool.id);
        const execute = tool.execute;
        if (!execute)
          throw new Error(`Plugin Tool requires execute: ${tool.id}`);
        // Clone the instance rather than mutating a plugin export or losing its prototype.
        const guarded = Object.create(
          Object.getPrototypeOf(tool),
          Object.getOwnPropertyDescriptors(tool),
        ) as typeof tool;
        guarded.execute = async (...args: Parameters<typeof execute>) => {
          await this.assertEnabled(id);
          return execute.apply(tool, args);
        };
        server.tools = (server.tools ?? []).map((item) =>
          item === tool ? guarded : item,
        );
      }
      this.servers.set(id, server);
    }
  }

  async list(): Promise<PluginStatus[]> {
    const [installations, migrations] = await Promise.all([
      this.database.query<Installation[]>(
        'SELECT id, version, enabled FROM plugin_installations',
      ),
      this.database.query<{ plugin_id: string; name: string }[]>(
        'SELECT plugin_id, name FROM plugin_migrations',
      ),
    ]);
    const states = this.definitions.map(({ manifest, database }) => {
      const row = installations.find((item) => item.id === manifest.id);
      const ready =
        row?.version === manifest.version &&
        database.migrations.every((Migration) =>
          migrations.some(
            (m) =>
              m.plugin_id === manifest.id &&
              m.name === (new Migration().name ?? Migration.name),
          ),
        );
      return {
        ...manifest,
        installedVersion: row?.version ?? null,
        ready,
        enabled: ready && !!row?.enabled,
        reason: ready ? null : '需要运行数据库迁移并发布相同版本',
      };
    });
    // Definitions are topologically ordered by discovery.
    for (const state of states) {
      if (
        state.dependencies.some(
          (id) => !states.find((s) => s.id === id)?.enabled,
        )
      ) {
        state.enabled = false;
        state.reason = '依赖插件未启用';
      }
    }
    return states;
  }

  async assertEnabled(id: string) {
    if (!(await this.list()).some((state) => state.id === id && state.enabled))
      throw new PluginError('PLUGIN_DISABLED', 404);
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginStatus> {
    const runner = this.database.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await runner.query(
        "SELECT pg_advisory_xact_lock(hashtext('host-plugin-state'))",
      );
      const states = await this.list();
      const target = states.find((state) => state.id === id);
      if (!target) throw new PluginError('PLUGIN_NOT_FOUND', 404);
      if (!target.ready) throw new PluginError('PLUGIN_MIGRATION_REQUIRED');
      if (
        enabled &&
        target.dependencies.some(
          (dependency) => !states.find((s) => s.id === dependency)?.enabled,
        )
      )
        throw new PluginError('PLUGIN_DEPENDENCY_DISABLED');
      if (
        !enabled &&
        states.some((state) => state.enabled && state.dependencies.includes(id))
      )
        throw new PluginError('PLUGIN_HAS_DEPENDENTS');
      await runner.query(
        'UPDATE plugin_installations SET enabled = $2, updated_at = now() WHERE id = $1',
        [id, enabled],
      );
      await runner.commitTransaction();
      return { ...target, enabled, reason: null };
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  api(id: string) {
    return this.servers.get(id)?.api;
  }

  async agents(): Promise<BaseAgent[]> {
    const states = await this.list();
    return states
      .filter((s) => s.enabled)
      .flatMap((s) => structuredClone(this.servers.get(s.id)?.agents ?? []));
  }

  ownsTool(id: string) {
    return [...this.servers.values()].some((s) =>
      s.tools?.some((tool) => tool.id === id),
    );
  }

  async toolConfigs(
    defaults: Partial<Record<string, { enabled?: boolean }>> = {},
  ): Promise<ToolConfig[]> {
    const states = await this.list();
    const rows = await this.database.query<
      { id: string; value: { enabled?: boolean } }[]
    >(
      "SELECT id, value FROM settings WHERE id LIKE 'tool:plugin_%' AND deleted_at IS NULL",
    );
    return states.flatMap((state) =>
      (this.servers.get(state.id)?.tools ?? []).map((tool) => ({
        id: tool.id,
        kind: 'builtin' as const,
        description: tool.description?.split('\n')[0] ?? tool.id,
        config: {
          enabled:
            state.enabled &&
            (rows.find((row) => row.id === `tool:${tool.id}`)?.value.enabled ??
              defaults[tool.id]?.enabled ??
              true),
        },
      })),
    );
  }

  async tools(
    defaults: Partial<Record<string, { enabled?: boolean }>> = {},
  ): Promise<ToolsInput> {
    const enabled = new Set(
      (await this.toolConfigs(defaults))
        .filter((t) => t.config.enabled)
        .map((t) => t.id),
    );
    return Object.fromEntries(
      [...this.servers.values()].flatMap((s) =>
        (s.tools ?? []).filter((t) => enabled.has(t.id)).map((t) => [t.id, t]),
      ),
    );
  }

  async dispose() {
    await Promise.all([...this.servers.values()].map((s) => s.dispose?.()));
  }
}
