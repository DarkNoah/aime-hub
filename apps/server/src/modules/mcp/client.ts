import { randomUUID } from 'node:crypto';
import {
  MCPClient,
  type MastraMCPServerDefinition,
  type OAuthClientProvider,
} from '@mastra/mcp';
import { mcpConfigSchema, type McpInput } from '@aime/shared/mcp';

export const mcpDiscoveryTimeout = 60_000;

export function toMastraServer(
  input: McpInput,
  authProvider?: OAuthClientProvider,
): MastraMCPServerDefinition {
  const config = mcpConfigSchema.parse(input.config);
  if (config.command)
    return {
      command: config.command,
      args: config.args,
      env: config.env,
      timeout: mcpDiscoveryTimeout,
      enableServerLogs: false,
    };
  const headers = config.headers ?? {};
  const endpoint = new URL(config.url!);
  return {
    url: endpoint,
    authProvider,
    requestInit: { headers },
    // SSE's event-stream GET also needs authentication, not just HTTP POSTs.
    fetch: (url, init) => {
      const merged = new Headers(init?.headers);
      // OAuth discovery/token endpoints may live on a different origin.
      if (
        new URL(url instanceof Request ? url.url : url).origin ===
        endpoint.origin
      )
        for (const [key, value] of Object.entries(headers))
          merged.set(key, value);
      return globalThis.fetch(url, { ...init, headers: merged });
    },
    timeout: mcpDiscoveryTimeout,
    enableServerLogs: false,
  };
}

export function createMcpClient(
  servers: McpInput[],
  providers: Record<string, OAuthClientProvider | undefined> = {},
) {
  return new MCPClient({
    id: `mcp-${randomUUID()}`,
    timeout: mcpDiscoveryTimeout,
    servers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        toMastraServer(server, providers[server.name]),
      ]),
    ),
  });
}
