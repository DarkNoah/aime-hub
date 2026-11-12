import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type {
  McpOAuthStore,
  OAuthNamespace,
} from '../../apps/server/src/modules/mcp/oauth-store.js';
import { McpError } from '../../apps/server/src/modules/mcp/errors.js';
type OAuthStorage = ReturnType<McpOAuthStore['storage']>;

export class MemoryOAuthStore implements McpOAuthStore {
  records = new Map<
    string,
    { binding: string; generation: string; data: Map<string, string> }
  >();
  sessions = new Map<
    string,
    { userId: string; serverId: string; expires: number; payload: string }
  >();
  async ensure(serverId: string, binding: string, userId: string) {
    if (this.records.get(`${serverId}:${userId}`)?.binding !== binding)
      this.records.set(`${serverId}:${userId}`, {
        binding,
        generation: randomUUID(),
        data: new Map(),
      });
    return {
      serverId,
      userId,
      generation: this.records.get(`${serverId}:${userId}`)!.generation,
    };
  }
  async namespace(serverId: string, binding: string, userId: string) {
    const row = this.records.get(`${serverId}:${userId}`);
    return row?.binding === binding
      ? { serverId, userId, generation: row.generation }
      : undefined;
  }
  storage(namespace: OAuthNamespace): OAuthStorage {
    const row = () => {
      const value = this.records.get(
        `${namespace.serverId}:${namespace.userId}`,
      );
      if (value?.generation !== namespace.generation)
        throw new McpError('MCP_CONFLICT', 409);
      return value;
    };
    return {
      get: (key) => row().data.get(key),
      set: (key, value) => {
        row().data.set(key, value);
      },
      delete: (key) => {
        row().data.delete(key);
      },
    };
  }
  async rotate(namespace: OAuthNamespace) {
    const row = this.records.get(`${namespace.serverId}:${namespace.userId}`)!;
    if (row.generation !== namespace.generation)
      throw new McpError('MCP_CONFLICT', 409);
    row.generation = randomUUID();
    row.data.clear();
    return {
      serverId: namespace.serverId,
      userId: namespace.userId,
      generation: row.generation,
    };
  }
  async remove(serverId: string, userId?: string) {
    for (const key of this.records.keys())
      if (
        userId
          ? key === `${serverId}:${userId}`
          : key.startsWith(`${serverId}:`)
      )
        this.records.delete(key);
    for (const [key, value] of this.sessions)
      if (value.serverId === serverId && (!userId || value.userId === userId))
        this.sessions.delete(key);
  }
  async saveSession(
    state: string,
    serverId: string,
    userId: string,
    payload: string,
  ) {
    for (const [key, value] of this.sessions)
      if (value.serverId === serverId && (!userId || value.userId === userId))
        this.sessions.delete(key);
    this.sessions.set(state, {
      userId,
      serverId,
      expires: Date.now() + 600_000,
      payload,
    });
  }
  async consumeSession(state: string, userId: string) {
    const row = this.sessions.get(state);
    if (!row || row.userId !== userId || row.expires <= Date.now())
      return undefined;
    this.sessions.delete(state);
    return row.payload;
  }
}

export async function authorizationServer(browserConsent = false) {
  let origin = '';
  let accessToken = '';
  let refreshToken = '';
  let refreshes = 0;
  let exchanges = 0;
  let rejectRefresh = false;
  let omitRefreshToken = false;
  let temporaryRefreshFailure = false;
  const registrations: Record<string, unknown>[] = [];
  const codes = new Map<
    string,
    { challenge: string; redirect: string; account: string }
  >();
  const accessTokens = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    let body = '';
    for await (const chunk of req) body += chunk;
    if (url.pathname === '/metadata')
      return json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['read'],
      });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['read', 'offline_access'],
      });
    if (url.pathname === '/register') {
      const metadata = JSON.parse(body);
      registrations.push(metadata);
      if (
        metadata.application_type === 'native' &&
        metadata.redirect_uris.some((uri: string) => {
          const target = new URL(uri);
          return (
            target.protocol === 'http:' &&
            !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
          );
        })
      )
        return json({ error: 'invalid_redirect_uri' }, 400);
      return json({ ...metadata, client_id: 'registered-client' }, 201);
    }
    if (
      url.pathname === '/authorize' &&
      browserConsent &&
      !url.searchParams.has('approve')
    ) {
      url.searchParams.set('approve', 'yes');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<html><body><h1>OAuth test consent</h1><a href="${url.toString().replaceAll('&', '&amp;')}">Authorize test MCP</a></body></html>`,
      );
      return;
    }
    if (url.pathname === '/authorize') {
      const code = randomUUID();
      const redirect = url.searchParams.get('redirect_uri')!;
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge')!,
        redirect,
        account: randomUUID(),
      });
      const target = new URL(redirect);
      target.searchParams.set('code', code);
      target.searchParams.set('state', url.searchParams.get('state')!);
      target.searchParams.set('iss', origin);
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body);
      let account: string;
      if (params.get('grant_type') === 'authorization_code') {
        const code = params.get('code')!;
        const stored = codes.get(code);
        codes.delete(code);
        const challenge = createHash('sha256')
          .update(params.get('code_verifier') ?? '')
          .digest('base64url');
        if (
          !stored ||
          stored.challenge !== challenge ||
          stored.redirect !== params.get('redirect_uri')
        )
          return json({ error: 'invalid_grant' }, 400);
        account = stored.account;
        exchanges++;
      } else {
        refreshes++;
        if (temporaryRefreshFailure) {
          temporaryRefreshFailure = false;
          return json({ error: 'server_error' }, 503);
        }
        if (rejectRefresh || !refreshTokens.has(params.get('refresh_token')!))
          return json({ error: 'invalid_grant' }, 400);
        refreshToken = params.get('refresh_token')!;
        account = refreshTokens.get(refreshToken)!;
        if (!omitRefreshToken) refreshTokens.delete(refreshToken);
      }
      accessToken = `access-${randomUUID()}`;
      if (!omitRefreshToken || !refreshToken)
        refreshToken = `refresh-${randomUUID()}`;
      accessTokens.set(accessToken, account);
      refreshTokens.set(refreshToken, account);
      return json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        ...(!omitRefreshToken ? { refresh_token: refreshToken } : {}),
        scope: 'read offline_access',
      });
    }
    if (url.pathname === '/mcp') {
      if (
        !accessTokens.has(
          req.headers.authorization?.replace(/^Bearer /, '') ?? '',
        )
      ) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/metadata"`,
        });
        return res.end();
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end();
      }
      const request = JSON.parse(body);
      if (request.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              serverInfo: { name: 'oauth-fixture', version: '1' },
              capabilities: { tools: {} },
            }
          : request.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'read',
                    description: 'Read authorized data',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              }
            : request.method === 'tools/call'
              ? {
                  content: [
                    {
                      type: 'text',
                      text: `authorized-value:${accessTokens.get(req.headers.authorization!.slice(7))}`,
                    },
                  ],
                }
              : request.method === 'ping'
                ? {}
                : undefined;
      return json(
        result
          ? { jsonrpc: '2.0', id: request.id, result }
          : {
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32601, message: 'Unknown method' },
            },
      );
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    registrations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    get accessToken() {
      return accessToken;
    },
    get refreshToken() {
      return refreshToken;
    },
    get refreshes() {
      return refreshes;
    },
    get exchanges() {
      return exchanges;
    },
    expireAccess() {
      accessToken = 'expired';
      accessTokens.clear();
    },
    rejectRefresh() {
      rejectRefresh = true;
    },
    omitRefresh() {
      omitRefreshToken = true;
    },
    failRefreshOnce() {
      temporaryRefreshFailure = true;
    },
    async consent(url: string) {
      const response = await fetch(url, { redirect: 'manual' });
      return Object.fromEntries(
        new URL(response.headers.get('location')!).searchParams,
      );
    },
  };
}
