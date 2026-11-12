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
  type McpAuthorization,
} from '@aime/shared/mcp';
import { McpError } from './errors.js';
import { createMcpClient, mcpDiscoveryTimeout } from './client.js';
import { McpOAuth, oauthBinding } from './oauth.js';

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
  private authEpochs = new Map<string, number>();
  constructor(
    private readonly store: MCPClientsStorage,
    private readonly clientFactory = createMcpClient,
    private readonly oauth?: McpOAuth,
  ) {}

  private view(row: StorageMCPClientType, userId?: string): McpServer {
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
      ...this.runtimeState(
        { id: row.id, revision, status: row.status, config },
        userId,
      ),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private runtimeState(
    server: Pick<McpServer, 'id' | 'revision' | 'status' | 'config'>,
    userId?: string,
  ): Pick<McpServer, 'connectionStatus' | 'toolCount'> {
    if (server.status !== 'published') return { connectionStatus: 'unloaded' };
    const key = this.connectionKey(server, userId);
    const state = this.loadStates.get(key);
    if (state?.revision === server.revision)
      return { connectionStatus: state.status };
    const connection = this.connections.get(key);
    return connection?.revision === server.revision
      ? {
          connectionStatus: 'loaded',
          toolCount: Object.keys(connection.tools).length,
        }
      : { connectionStatus: 'unloaded' };
  }

  private connectionKey(
    server: Pick<McpServer, 'id' | 'config'>,
    userId?: string,
  ) {
    return server.config.oauth ? `${server.id}:${userId ?? ''}` : server.id;
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

  async get(id: string, userId?: string) {
    return this.withAuthStatus(
      this.view(await this.record(id), userId),
      userId,
    );
  }

  private async withAuthStatus(
    server: McpServer,
    userId?: string,
  ): Promise<McpServer> {
    if (!server.config.oauth) return server;
    return {
      ...server,
      authStatus: (await this.oauth?.status(server, userId)) ?? 'required',
    };
  }

  async list(userId?: string): Promise<McpServer[]> {
    // Mastra's default list only includes published records. The editor also needs drafts.
    const pages = await Promise.all(
      (['draft', 'published', 'archived'] as const).map((status) =>
        this.store.list({ status, metadata: marker, perPage: false }),
      ),
    );
    const servers = pages
      .flatMap((page) => page.mcpClients)
      .map((row) => this.view(row, userId))
      .sort((a, b) => a.name.localeCompare(b.name));
    return Promise.all(
      servers.map((server) => this.withAuthStatus(server, userId)),
    );
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

  update(id: string, input: McpUpdate, userId?: string) {
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
      const previous = this.view(row);
      const authChanged =
        oauthBinding(previous.config) !== oauthBinding(server.config);
      const candidate =
        row.status === 'published' && !server.config.oauth
          ? await this.probe({
              ...this.view(row),
              ...server,
              revision: nextRevision,
            })
          : undefined;
      try {
        // Replace the nested config as a whole: changing transport must clear the old fields.
        await this.store.update({
          id,
          metadata: {
            ...row.metadata,
            ...server,
            revision: nextRevision,
          },
        });
      } catch (error) {
        if (candidate) await this.disconnect(candidate);
        throw error;
      }
      if (authChanged) await this.oauth?.remove(id);
      await this.invalidate(id);
      if (candidate) await this.replace(id, candidate);
      return this.get(id, userId);
    });
  }

  setStatus(id: string, input: McpStatus, userId?: string) {
    return this.exclusive(async () => {
      const { status, revision } = mcpStatusSchema.parse(input);
      const row = await this.record(id);
      this.checkRevision(row, revision);
      const server = this.view(row);
      if (server.status === status) return this.get(id, userId);
      const version =
        status === 'published'
          ? await this.store.getLatestVersion(id)
          : undefined;
      if (status === 'published' && !version)
        throw new McpError('MCP_CONFIG_INVALID', 409);
      const nextRevision = randomUUID();
      // OAuth connections are published for everyone; each user authorizes independently.
      const candidate =
        status === 'published' && !server.config.oauth
          ? await this.probe({ ...server, revision: nextRevision })
          : undefined;
      try {
        await this.store.update({
          id,
          status,
          ...(version ? { activeVersionId: version.id } : {}),
          metadata: { ...row.metadata, revision: nextRevision },
        });
      } catch (error) {
        if (candidate) await this.disconnect(candidate);
        throw error;
      }
      await this.invalidate(id);
      if (candidate) await this.replace(id, candidate);
      return this.get(id, userId);
    });
  }

  remove(id: string, revision: string) {
    return this.exclusive(async () => {
      const row = await this.record(id);
      this.checkRevision(row, revision);
      await this.store.delete(id);
      await this.oauth?.remove(id);
      await this.invalidate(id);
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
    const servers = (await this.published()).filter(
      (server) => !server.config.oauth,
    );
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
  async getTools(userId?: string): Promise<ToolMap> {
    if (this.stopping) throw new McpError('MCP_UNAVAILABLE', 503);
    const servers = await this.published();
    const tools: ToolMap = {};
    for (const server of servers) {
      if (server.config.oauth) {
        if (
          !userId ||
          (await this.oauth?.status(server, userId)) !== 'authorized'
        )
          continue;
        if (
          this.connections.get(this.connectionKey(server, userId))?.revision !==
          server.revision
        ) {
          try {
            await this.load(server.id, userId);
          } catch {
            continue;
          }
        }
      }
      const connection = this.connections.get(
        this.connectionKey(server, userId),
      );
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
  listTools(id: string, userId?: string): Promise<McpToolDefinition[]> {
    return this.exclusive(async () => {
      const [server] = await this.published([id]);
      const connection = this.connections.get(
        this.connectionKey(server, userId),
      );
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

  async testConnection(id: string, userId?: string) {
    const server = await this.load(id, userId);
    return { toolCount: server.toolCount ?? 0 };
  }

  /** Discover first, then activate. Concurrent startup/UI requests share the same probe. */
  async load(id: string, userId?: string): Promise<McpServer> {
    if (this.stopping) throw new McpError('MCP_UNAVAILABLE', 503);
    const [server] = await this.published([id]);
    if (this.stopping) throw new McpError('MCP_UNAVAILABLE', 503);
    const connectionKey = this.connectionKey(server, userId);
    const epoch = this.authEpochs.get(connectionKey) ?? 0;
    const key = `${connectionKey}:${server.revision}:${epoch}`;
    const pending = this.loads.get(key);
    if (pending) return pending;
    const previous = this.connections.get(connectionKey);
    this.loadStates.set(connectionKey, {
      revision: server.revision,
      status: 'loading',
    });
    const result = (async () => {
      let candidate: Connection | undefined;
      try {
        candidate =
          previous?.revision === server.revision
            ? previous
            : await this.probe(server, userId);
        const tools =
          candidate === previous
            ? this.guardedTools(
                server,
                await this.discover(candidate.client, server, userId),
                userId,
              )
            : candidate.tools;
        return await this.exclusive(async () => {
          const [current] = await this.published([id]);
          if (
            current.revision !== server.revision ||
            (this.authEpochs.get(connectionKey) ?? 0) !== epoch
          )
            throw new McpError('MCP_CONFLICT', 409);
          candidate!.tools = tools;
          await this.replace(connectionKey, candidate);
          return this.get(id, userId);
        });
      } catch (error) {
        if (candidate && candidate !== previous)
          await this.disconnect(candidate);
        await this.exclusive(async () => {
          // A late failure must not remove a newer publication or connection.
          const current = await this.get(id);
          if (
            current.status !== 'published' ||
            current.revision !== server.revision ||
            (this.authEpochs.get(connectionKey) ?? 0) !== epoch
          )
            return;
          if (this.connections.get(connectionKey) === previous)
            await this.replace(connectionKey);
          this.loadStates.set(connectionKey, {
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

  private async discover(client: Client, server?: McpServer, userId?: string) {
    try {
      const { tools, errors } = await client.listToolsWithErrors({
        perServerTimeoutMs: mcpDiscoveryTimeout,
      });
      if (Object.keys(errors).length)
        throw new McpError('MCP_CONNECTION_FAILED', 502);
      return tools;
    } catch {
      if (
        server?.config.oauth &&
        (await this.oauth?.status(server, userId)) === 'required'
      )
        throw new McpError('MCP_AUTH_REQUIRED', 401);
      // Remote errors can contain credentials, process arguments and local paths.
      throw new McpError('MCP_CONNECTION_FAILED', 502);
    }
  }

  private async probe(server: McpServer, userId?: string): Promise<Connection> {
    if (
      server.config.oauth &&
      (!userId || (await this.oauth?.status(server, userId)) !== 'authorized')
    )
      throw new McpError('MCP_AUTH_REQUIRED', 401);
    const provider =
      server.config.oauth && userId
        ? await this.oauth?.provider(server, userId)
        : undefined;
    const client = this.clientFactory([server], { [server.name]: provider });
    try {
      const tools = await this.discover(client, server, userId);
      return {
        client,
        revision: server.revision,
        tools: this.guardedTools(server, tools, userId),
      };
    } catch (error) {
      await this.disconnect({ client });
      throw error;
    }
  }

  startOAuth(
    id: string,
    userId: string,
    origin: string,
    revision: string,
    returnTo = '/admin/mcp',
    allowDraft = true,
  ) {
    return this.exclusive(async () => {
      const row = await this.record(id);
      this.checkRevision(row, revision);
      if (!allowDraft && row.status !== 'published')
        throw new McpError('MCP_NOT_PUBLISHED', 409);
      if (!this.oauth) throw new McpError('MCP_OAUTH_NOT_ENABLED');
      return this.oauth.begin(this.view(row), userId, origin, returnTo);
    });
  }

  async authorizations(
    userId: string,
    id?: string,
  ): Promise<McpAuthorization[]> {
    const servers = id ? await this.published([id]) : await this.published();
    return Promise.all(
      servers
        .filter((server) => server.config.oauth)
        .map(async (server) => ({
          id: server.id,
          name: server.name,
          authStatus: (await this.oauth?.status(server, userId)) ?? 'required',
          connectionStatus: this.runtimeState(server, userId).connectionStatus,
        })),
    );
  }

  async startUserOAuth(
    id: string,
    userId: string,
    origin: string,
    returnTo: string,
  ) {
    const [server] = await this.published([id]);
    return this.startOAuth(
      id,
      userId,
      origin,
      server.revision,
      returnTo,
      false,
    );
  }

  finishOAuth(
    userId: string,
    query: { state?: string; code?: string; error?: string; iss?: string },
    allowDraft = false,
  ) {
    return this.exclusive(async () => {
      if (!this.oauth) throw new McpError('MCP_OAUTH_NOT_ENABLED');
      const result = await this.oauth.complete(userId, query, async (id) => {
        const server = await this.get(id, userId);
        if (!allowDraft && server.status !== 'published')
          throw new McpError('MCP_NOT_PUBLISHED', 409);
        return server;
      });
      if (result.outcome !== 'success') return result;
      const server = await this.get(result.serverId, userId);
      const key = this.connectionKey(server, userId);
      this.authEpochs.set(key, (this.authEpochs.get(key) ?? 0) + 1);
      await this.replace(key);
      if (server.status === 'published') {
        try {
          await this.replace(key, await this.probe(server, userId));
        } catch {
          this.loadStates.set(key, {
            revision: server.revision,
            status: 'error',
          });
          return { ...result, outcome: 'connection-failed' as const };
        }
      }
      return result;
    });
  }

  disconnectOAuth(id: string, revision: string, userId: string) {
    return this.exclusive(async () => {
      const row = await this.record(id);
      this.checkRevision(row, revision);
      const server = this.view(row);
      if (!server.config.oauth) throw new McpError('MCP_OAUTH_NOT_ENABLED');
      const key = this.connectionKey(server, userId);
      this.authEpochs.set(key, (this.authEpochs.get(key) ?? 0) + 1);
      await this.oauth?.remove(id, userId);
      await this.replace(key);
      return this.get(id, userId);
    });
  }

  private guardedTools(
    server: McpServer,
    tools: ToolMap,
    userId?: string,
  ): ToolMap {
    const key = this.connectionKey(server, userId);
    const epoch = this.authEpochs.get(key) ?? 0;
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
                  if (
                    server.config.oauth &&
                    args[1]?.requestContext?.get('userId') !== userId
                  )
                    throw new McpError('FORBIDDEN', 403);
                  const current = await this.get(server.id, userId);
                  if (this.stopping || current.status !== 'published')
                    throw new McpError('MCP_NOT_PUBLISHED', 409);
                  if (
                    current.revision !== server.revision ||
                    (this.authEpochs.get(key) ?? 0) !== epoch ||
                    this.connections.get(key)?.revision !== server.revision
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

  private async invalidate(id: string) {
    const keys = new Set([
      ...this.connections.keys(),
      ...this.loadStates.keys(),
    ]);
    await Promise.all(
      [...keys]
        .filter((key) => key === id || key.startsWith(`${id}:`))
        .map((key) => this.replace(key)),
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
