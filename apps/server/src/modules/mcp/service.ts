import { randomUUID } from 'node:crypto';
import type {
  MCPClientsStorage,
  StorageMCPClientType,
} from '@mastra/core/storage';
import { z } from 'zod';
import {
  mcpInputSchema,
  mcpCreateSchema,
  mcpUpdateSchema,
  mcpStatusSchema,
  type McpServer,
  type McpCreate,
  type McpUpdate,
  type McpStatus,
  type McpToolDefinition,
} from '@aime/shared/mcp';
import { McpError } from './errors.js';
import { createMcpClient, mcpDiscoveryTimeout } from './client.js';

const marker = { managedBy: 'admin-mcp', configVersion: 1 };
const metadataSchema = mcpInputSchema.extend({ revision: z.string().uuid() });
type Client = ReturnType<typeof createMcpClient>;
type ToolMap = Awaited<ReturnType<Client['listTools']>>;
type Connection = { client: Client; revision: string; tools: ToolMap };

/** Connection configuration lives in native MCP client metadata, without a transport discriminator. */
export class McpService {
  private mutations = Promise.resolve();
  private connections = new Map<string, Connection>();
  private loads = new Map<string, Promise<McpServer>>();
  private loadStates = new Map<
    string,
    { revision: string; status: 'loading' | 'error' }
  >();
  private stopping = false;
  constructor(
    private readonly store: MCPClientsStorage,
    private readonly clientFactory = createMcpClient,
  ) {}

  private view(row: StorageMCPClientType): McpServer {
    const { name, config, revision } = metadataSchema.parse({
      name: row.metadata?.name,
      config: row.metadata?.config,
      revision: row.metadata?.revision,
    });
    return {
      id: row.id,
      name,
      config,
      revision,
      status: row.status,
      ...this.runtimeState({ id: row.id, revision, status: row.status }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private runtimeState(
    server: Pick<McpServer, 'id' | 'revision' | 'status'>,
  ): Pick<McpServer, 'connectionStatus' | 'toolCount'> {
    if (server.status !== 'published') return { connectionStatus: 'unloaded' };
    const state = this.loadStates.get(server.id);
    if (state?.revision === server.revision)
      return { connectionStatus: state.status };
    const connection = this.connections.get(server.id);
    return connection?.revision === server.revision
      ? {
          connectionStatus: 'loaded',
          toolCount: Object.keys(connection.tools).length,
        }
      : { connectionStatus: 'unloaded' };
  }

  private async record(id: string) {
    const row = await this.store.getById(id);
    if (
      !row ||
      row.metadata?.managedBy !== marker.managedBy ||
      row.metadata?.configVersion !== marker.configVersion
    )
      throw new McpError('MCP_NOT_FOUND', 404);
    return row;
  }

  async get(id: string) {
    return this.view(await this.record(id));
  }

  async list(): Promise<McpServer[]> {
    // Mastra's default list only includes published records. The editor also needs drafts.
    const pages = await Promise.all(
      (['draft', 'published', 'archived'] as const).map((status) =>
        this.store.list({ status, metadata: marker, perPage: false }),
      ),
    );
    return pages
      .flatMap((page) => page.mcpClients)
      .map((row) => this.view(row))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  create(authorId: string, input: McpCreate) {
    return this.exclusive(async () => {
      const { servers } = mcpCreateSchema.parse(input);
      const existing = new Set(
        (await this.list()).map((server) => server.name),
      );
      if (servers.some((server) => existing.has(server.name)))
        throw new McpError('MCP_NAME_CONFLICT', 409);
      const created: McpServer[] = [];
      try {
        for (const server of servers) {
          const id = randomUUID();
          const row = await this.store.create({
            mcpClient: {
              id,
              authorId,
              // Required native snapshot shell; the metadata is the source of truth.
              // Native servers would require persisting type and cannot represent headers.
              name: id,
              servers: {},
              metadata: { ...marker, ...server, revision: randomUUID() },
            },
          });
          created.push(this.view(row));
        }
        return created;
      } catch (error) {
        const rollback = await Promise.allSettled(
          created.map((server) => this.store.delete(server.id)),
        );
        if (rollback.some((result) => result.status === 'rejected'))
          throw new McpError('MCP_IMPORT_INCOMPLETE', 500);
        throw error;
      }
    });
  }

  update(id: string, input: McpUpdate) {
    return this.exclusive(async () => {
      const { revision, ...server } = mcpUpdateSchema.parse(input);
      const row = await this.record(id);
      this.checkRevision(row, revision);
      if (
        (await this.list()).some(
          (item) => item.id !== id && item.name === server.name,
        )
      )
        throw new McpError('MCP_NAME_CONFLICT', 409);
      const nextRevision = randomUUID();
      const candidate =
        row.status === 'published'
          ? await this.probe({
              ...this.view(row),
              ...server,
              revision: nextRevision,
            })
          : undefined;
      let updated;
      try {
        // Replace the nested config as a whole: changing transport must clear the old fields.
        updated = this.view(
          await this.store.update({
            id,
            metadata: {
              ...row.metadata,
              ...server,
              revision: nextRevision,
            },
          }),
        );
      } catch (error) {
        if (candidate) await this.disconnect(candidate);
        throw error;
      }
      await this.replace(id, candidate);
      return { ...updated, ...this.runtimeState(updated) };
    });
  }

  setStatus(id: string, input: McpStatus) {
    return this.exclusive(async () => {
      const { status, revision } = mcpStatusSchema.parse(input);
      const row = await this.record(id);
      this.checkRevision(row, revision);
      const server = this.view(row);
      if (server.status === status) return server;
      const version =
        status === 'published'
          ? await this.store.getLatestVersion(id)
          : undefined;
      if (status === 'published' && !version)
        throw new McpError('MCP_CONFIG_INVALID', 409);
      const nextRevision = randomUUID();
      // Discovery must finish successfully before the native publication state changes.
      const candidate =
        status === 'published'
          ? await this.probe({ ...server, revision: nextRevision })
          : undefined;
      let updated;
      try {
        updated = this.view(
          await this.store.update({
            id,
            status,
            ...(version ? { activeVersionId: version.id } : {}),
            metadata: { ...row.metadata, revision: nextRevision },
          }),
        );
      } catch (error) {
        if (candidate) await this.disconnect(candidate);
        throw error;
      }
      await this.replace(id, candidate);
      return { ...updated, ...this.runtimeState(updated) };
    });
  }

  remove(id: string, revision: string) {
    return this.exclusive(async () => {
      const row = await this.record(id);
      this.checkRevision(row, revision);
      await this.store.delete(id);
      await this.replace(id);
    });
  }

  /** All runtime access goes through the stored publication status, never a caller's flag. */
  async published(ids?: string[]) {
    const servers = ids
      ? await Promise.all([...new Set(ids)].map((id) => this.get(id)))
      : (
          await this.store.list({
            status: 'published',
            metadata: marker,
            perPage: false,
          })
        ).mcpClients.map((row) => this.view(row));
    if (servers.some((server) => server.status !== 'published'))
      throw new McpError('MCP_NOT_PUBLISHED', 409);
    return servers;
  }

  /** Run after HTTP starts; each server probes independently without holding the mutation queue. */
  async initialize() {
    const servers = await this.published();
    const results = await Promise.allSettled(
      servers.map(async (server) => {
        if (this.connections.get(server.id)?.revision === server.revision)
          return;
        await this.load(server.id);
      }),
    );
    const failed = results.filter(
      (result) => result.status === 'rejected',
    ).length;
    if (failed)
      console.warn(
        `MCP startup: ${failed} published connection(s) unavailable`,
      );
    return { connected: servers.length - failed, failed };
  }

  /** Agents share the process-owned clients. Constructing an Agent never creates a client. */
  async getTools(): Promise<ToolMap> {
    if (this.stopping) throw new McpError('MCP_UNAVAILABLE', 503);
    const servers = await this.published();
    const tools: ToolMap = {};
    for (const server of servers) {
      const connection = this.connections.get(server.id);
      // Read only: slow admin connection checks must not stall ongoing chats.
      // Missing connections are recovered by startup or an explicit connection test.
      if (connection?.revision === server.revision) {
        for (const [name, tool] of Object.entries(connection.tools)) {
          if (Object.hasOwn(tools, name))
            throw new McpError('MCP_TOOL_NAME_CONFLICT', 409);
          tools[name] = tool;
        }
      }
    }
    return tools;
  }

  /** Read the native catalog over the resident client; serialize reads with connection replacement. */
  listTools(id: string): Promise<McpToolDefinition[]> {
    return this.exclusive(async () => {
      const [server] = await this.published([id]);
      const connection = this.connections.get(id);
      if (!connection || connection.revision !== server.revision)
        throw new McpError('MCP_UNAVAILABLE', 503);
      try {
        const { definitions, errors } =
          await connection.client.listToolDefinitionsWithErrors({
            perServerTimeoutMs: mcpDiscoveryTimeout,
          });
        if (Object.keys(errors).length)
          throw new McpError('MCP_CONNECTION_FAILED', 502);
        // Only tool descriptions and schemas cross the admin API boundary.
        return Object.values(definitions[server.name] ?? {})
          .map(({ name, description, inputSchema, outputSchema }) => ({
            name,
            description,
            inputSchema,
            ...(outputSchema === undefined ? {} : { outputSchema }),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        throw new McpError('MCP_CONNECTION_FAILED', 502);
      }
    });
  }

  async testConnection(id: string) {
    const server = await this.load(id);
    return { toolCount: server.toolCount ?? 0 };
  }

  /** Discover first, then activate. Concurrent startup/UI requests share the same probe. */
  async load(id: string): Promise<McpServer> {
    if (this.stopping) throw new McpError('MCP_UNAVAILABLE', 503);
    const [server] = await this.published([id]);
    if (this.stopping) throw new McpError('MCP_UNAVAILABLE', 503);
    const key = `${id}:${server.revision}`;
    const pending = this.loads.get(key);
    if (pending) return pending;
    const previous = this.connections.get(id);
    this.loadStates.set(id, { revision: server.revision, status: 'loading' });
    const result = (async () => {
      let candidate: Connection | undefined;
      try {
        candidate =
          previous?.revision === server.revision
            ? previous
            : await this.probe(server);
        const tools =
          candidate === previous
            ? this.guardedTools(server, await this.discover(candidate.client))
            : candidate.tools;
        return await this.exclusive(async () => {
          const [current] = await this.published([id]);
          if (current.revision !== server.revision)
            throw new McpError('MCP_CONFLICT', 409);
          candidate!.tools = tools;
          await this.replace(id, candidate);
          return { ...current, ...this.runtimeState(current) };
        });
      } catch (error) {
        if (candidate && candidate !== previous)
          await this.disconnect(candidate);
        await this.exclusive(async () => {
          // A late failure must not remove a newer publication or connection.
          const current = await this.get(id);
          if (
            current.status !== 'published' ||
            current.revision !== server.revision
          )
            return;
          if (this.connections.get(id) === previous) await this.replace(id);
          this.loadStates.set(id, {
            revision: server.revision,
            status: 'error',
          });
        }).catch(() => undefined);
        throw error;
      }
    })();
    this.loads.set(key, result);
    try {
      return await result;
    } finally {
      this.loads.delete(key);
    }
  }

  private async discover(client: Client) {
    try {
      const { tools, errors } = await client.listToolsWithErrors({
        perServerTimeoutMs: mcpDiscoveryTimeout,
      });
      if (Object.keys(errors).length)
        throw new McpError('MCP_CONNECTION_FAILED', 502);
      return tools;
    } catch {
      // Remote errors can contain credentials, process arguments and local paths.
      throw new McpError('MCP_CONNECTION_FAILED', 502);
    }
  }

  private async probe(server: McpServer): Promise<Connection> {
    const client = this.clientFactory([server]);
    try {
      const tools = await this.discover(client);
      return {
        client,
        revision: server.revision,
        tools: this.guardedTools(server, tools),
      };
    } catch (error) {
      await this.disconnect({ client });
      throw error;
    }
  }

  private guardedTools(server: McpServer, tools: ToolMap): ToolMap {
    const names = new Set<string>();
    return Object.fromEntries(
      Object.entries(tools).map(([nativeName, tool]) => {
        // MCP tools run inside exec: preserve full names instead of applying provider name limits.
        const identifier = (value: string) =>
          value.replace(/[^a-zA-Z0-9_]/g, '_');
        const toolName = nativeName.startsWith(`${server.name}_`)
          ? nativeName.slice(server.name.length + 1)
          : nativeName;
        const name = `mcp__${identifier(server.name)}__${identifier(toolName)}`;
        if (names.has(name)) throw new McpError('MCP_TOOL_NAME_CONFLICT', 409);
        names.add(name);
        const execute = tool.execute;
        return [
          name,
          {
            ...tool,
            id: name,
            execute: execute
              ? async (...args: Parameters<typeof execute>) => {
                  const current = await this.get(server.id);
                  if (this.stopping || current.status !== 'published')
                    throw new McpError('MCP_NOT_PUBLISHED', 409);
                  if (
                    current.revision !== server.revision ||
                    this.connections.get(server.id)?.revision !==
                      server.revision
                  )
                    throw new McpError('MCP_CONFLICT', 409);
                  return execute(...args);
                }
              : undefined,
          },
        ];
      }),
    );
  }

  private async replace(id: string, next?: Connection) {
    this.loadStates.delete(id);
    const previous = this.connections.get(id);
    if (next) this.connections.set(id, next);
    else this.connections.delete(id);
    if (previous && previous !== next) await this.disconnect(previous);
  }

  private async disconnect(connection: Pick<Connection, 'client'>) {
    try {
      await connection.client.disconnect();
    } catch {
      console.warn('MCP client disconnect failed');
    }
  }

  async shutdown() {
    this.stopping = true;
    await Promise.allSettled(this.loads.values());
    await this.mutations;
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(
      connections.map((connection) => this.disconnect(connection)),
    );
  }

  private checkRevision(row: StorageMCPClientType, revision: string) {
    if (row.metadata?.revision !== revision)
      throw new McpError('MCP_CONFLICT', 409);
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(() => {
      if (this.stopping) throw new McpError('MCP_UNAVAILABLE', 503);
      return operation();
    });
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
