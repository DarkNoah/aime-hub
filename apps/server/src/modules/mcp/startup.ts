import type { Server } from 'node:http';
import type { McpService } from './service.js';

/** A failed HTTP bind must never launch MCP subprocesses. */
export function initializeMcpAfterListen(
  server: Server,
  mcp: Pick<McpService, 'initialize'>,
) {
  server.once('listening', () => {
    void mcp.initialize().catch(() => {
      // Storage/transport details may contain credentials; recovery is available in the UI.
      console.warn(
        'MCP startup discovery failed; retry loading from the MCP settings',
      );
    });
  });
}
