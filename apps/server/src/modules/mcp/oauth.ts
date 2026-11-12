import { createHash, randomBytes } from 'node:crypto';
import {
  auth,
  extractResourceMetadataUrl,
  MCPOAuthClientProvider,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthStorage,
  type OAuthTokens,
} from '@mastra/mcp';
import {
  mcpOAuthCallbackPath,
  type McpConfig,
  type McpServer,
} from '@aime/shared/mcp';
import { McpError } from './errors.js';
import type { McpOAuthStore, OAuthNamespace } from './oauth-store.js';

type Discovery = NonNullable<
  Awaited<ReturnType<NonNullable<OAuthClientProvider['discoveryState']>>>
>;
type StoredTokens = OAuthTokens & { issuer?: string; refresh_at?: number };

export function oauthBinding(config: McpConfig) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        url: config.url,
        clientId: config.oauth?.clientId || undefined,
        scope: config.oauth?.scope || undefined,
        headers: Object.entries(config.headers ?? {}).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
        enabled: !!config.oauth,
      }),
    )
    .digest('hex');
}

const oauthFetch: typeof fetch = (url, init) =>
  globalThis.fetch(url, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });

/** Adds durable discovery binding and expiry-aware, single-flight refresh to Mastra's provider. */
class PersistentOAuthProvider extends MCPOAuthClientProvider {
  private refresh?: Promise<void>;
  constructor(
    private readonly data: OAuthStorage,
    private readonly config: McpConfig,
    private readonly redirect: string,
    private readonly redirectUris: string[],
    private readonly interactive?: (url: URL) => void | Promise<void>,
    private readonly autoRefresh = true,
    state?: string,
  ) {
    super({
      storage: data,
      redirectUrl: redirect,
      clientMetadata: {
        client_name: 'Hub MCP',
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(config.oauth?.scope ? { scope: config.oauth.scope } : {}),
      },
      stateGenerator: () => state ?? randomBytes(32).toString('base64url'),
      onRedirectToAuthorization: async (url) => {
        if (interactive) await interactive(url);
        else {
          await data.set('needs_auth', 'true');
          throw new UnauthorizedError();
        }
      },
    });
  }

  override async clientInformation(
    context?: Parameters<OAuthClientProvider['clientInformation']>[0],
  ) {
    return (
      (await super.clientInformation()) ??
      (this.config.oauth?.clientId
        ? { client_id: this.config.oauth.clientId, issuer: context?.issuer }
        : undefined)
    );
  }

  async discoveryState(): Promise<Discovery | undefined> {
    const value = await this.data.get('discovery');
    return value ? (JSON.parse(value) as Discovery) : undefined;
  }
  async saveDiscoveryState(value: Discovery) {
    await this.data.set('discovery', JSON.stringify(value));
  }

  override async saveTokens(tokens: StoredTokens) {
    const previous = (await super.tokens()) as StoredTokens | undefined;
    const refreshToken =
      tokens.refresh_token ??
      (previous?.issuer === tokens.issuer
        ? previous?.refresh_token
        : undefined);
    await super.saveTokens({
      ...tokens,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      refresh_at:
        tokens.expires_in === undefined
          ? undefined
          : Date.now() +
            tokens.expires_in * 1000 -
            Math.min(30_000, tokens.expires_in * 100),
    } as StoredTokens);
    await this.data.delete('needs_auth');
  }

  override async tokens(): Promise<StoredTokens | undefined> {
    const tokens = (await super.tokens()) as StoredTokens | undefined;
    if (
      !this.autoRefresh ||
      !tokens?.refresh_at ||
      tokens.refresh_at > Date.now()
    )
      return tokens;
    if (!tokens.refresh_token) {
      await this.data.set('needs_auth', 'true');
      throw new UnauthorizedError();
    }
    if (!this.refresh) {
      // A separate provider reads raw tokens during auth(), avoiding recursion.
      let temporaryFailure = false;
      const provider = new PersistentOAuthProvider(
        this.data,
        this.config,
        this.redirect,
        this.redirectUris,
        async () => {
          // The SDK falls back to authorization after a transient refresh failure.
          // Keep saved credentials so the next request can retry without another login.
          if (temporaryFailure)
            throw new McpError('MCP_CONNECTION_FAILED', 502);
          await this.data.set('needs_auth', 'true');
          throw new UnauthorizedError();
        },
        false,
      );
      this.refresh = auth(provider, {
        serverUrl: this.config.url!,
        fetchFn: async (url, init) => {
          try {
            const response = await oauthFetch(url, init);
            if (response.status >= 500 || response.status === 429)
              temporaryFailure = true;
            return response;
          } catch (error) {
            temporaryFailure = true;
            throw error;
          }
        },
      })
        .then(() => undefined)
        .finally(() => {
          this.refresh = undefined;
        });
    }
    await this.refresh;
    return super.tokens();
  }

  override async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier',
  ) {
    await super.invalidateCredentials(scope);
    if (scope === 'tokens' || scope === 'all')
      await this.data.set('needs_auth', 'true');
    if (scope === 'all') await this.data.delete('discovery');
  }
}

type Session = {
  namespace: OAuthNamespace;
  binding: string;
  origin: string;
  returnTo: string;
  values: Record<string, string>;
};

export class McpOAuth {
  private providers = new Map<
    string,
    { generation: string; provider: PersistentOAuthProvider }
  >();
  constructor(
    private readonly store: McpOAuthStore,
    private readonly origins: readonly string[],
  ) {}

  private callback(origin: string) {
    return `${origin}${mcpOAuthCallbackPath}`;
  }
  private createProvider(
    data: OAuthStorage,
    config: McpConfig,
    origin = this.origins[0],
    redirect?: (url: URL) => void,
    state?: string,
  ) {
    return new PersistentOAuthProvider(
      data,
      config,
      this.callback(origin),
      // The SDK infers native vs web clients from this redirect. Registering
      // unrelated web origins can invalidate an otherwise valid loopback login.
      [this.callback(origin)],
      redirect,
      !redirect,
      state,
    );
  }

  async provider(
    server: McpServer,
    userId: string,
  ): Promise<OAuthClientProvider | undefined> {
    if (!server.config.oauth) return undefined;
    const namespace = await this.store.namespace(
      server.id,
      oauthBinding(server.config),
      userId,
    );
    if (!namespace) throw new McpError('MCP_AUTH_REQUIRED', 401);
    const key = `${server.id}:${userId}`;
    const current = this.providers.get(key);
    if (current?.generation === namespace.generation) return current.provider;
    const data = this.store.storage(namespace);
    const registeredOrigin = await data.get('client_origin');
    const provider = this.createProvider(
      data,
      server.config,
      registeredOrigin && this.origins.includes(registeredOrigin)
        ? registeredOrigin
        : this.origins[0],
    );
    this.providers.set(key, {
      generation: namespace.generation,
      provider,
    });
    return provider;
  }

  async status(
    server: McpServer,
    userId?: string,
  ): Promise<'required' | 'authorized' | undefined> {
    if (!server.config.oauth) return undefined;
    if (!userId) return 'required';
    const namespace = await this.store.namespace(
      server.id,
      oauthBinding(server.config),
      userId,
    );
    if (!namespace) return 'required';
    const data = this.store.storage(namespace);
    let raw: string | undefined;
    try {
      raw = await data.get('tokens');
    } catch (error) {
      if (
        error instanceof McpError &&
        ['MCP_OAUTH_STORAGE_FAILED', 'MCP_CONFLICT'].includes(error.code)
      )
        return 'required';
      throw error;
    }
    const tokens = raw ? (JSON.parse(raw) as StoredTokens) : undefined;
    return !(await data.get('needs_auth')) &&
      tokens?.access_token &&
      (!tokens.refresh_at ||
        tokens.refresh_at > Date.now() ||
        tokens.refresh_token)
      ? 'authorized'
      : 'required';
  }

  async remove(serverId: string, userId?: string) {
    for (const key of this.providers.keys())
      if (
        userId
          ? key === `${serverId}:${userId}`
          : key.startsWith(`${serverId}:`)
      )
        this.providers.delete(key);
    await this.store.remove(serverId, userId);
  }

  async begin(
    server: McpServer,
    userId: string,
    origin: string,
    returnTo = '/admin/mcp',
  ) {
    if (!this.origins.includes(origin)) throw new McpError('FORBIDDEN', 403);
    if (
      !returnTo.startsWith('/') ||
      returnTo.startsWith('//') ||
      returnTo.includes('\\') ||
      new URL(returnTo, origin).origin !== origin
    )
      throw new McpError('FORBIDDEN', 403);
    if (!server.config.oauth || !server.config.url)
      throw new McpError('MCP_OAUTH_NOT_ENABLED');
    const namespace = await this.store.ensure(
      server.id,
      oauthBinding(server.config),
      userId,
    );
    // Each authorization owns its verifier/discovery. Runtime refresh cannot overwrite it.
    const values: Record<string, string> = { client_origin: origin };
    const saved = this.store.storage(namespace);
    const existingClient = await saved.get('client_info');
    if (existingClient) {
      const registered = JSON.parse(existingClient) as {
        redirect_uris?: string[];
      };
      if (
        (await saved.get('client_origin')) === origin ||
        registered.redirect_uris?.includes(this.callback(origin))
      )
        values.client_info = existingClient;
    }
    const data: OAuthStorage = {
      get: (key) => values[key],
      set: (key, value) => {
        values[key] = value;
      },
      delete: (key) => {
        delete values[key];
      },
    };
    const state = randomBytes(32).toString('base64url');
    let authorizationUrl: URL | undefined;
    const provider = this.createProvider(
      data,
      server.config,
      origin,
      (url) => {
        authorizationUrl = url;
      },
      state,
    );
    try {
      const response = await oauthFetch(server.config.url, {
        headers: {
          ...server.config.headers,
          Accept: 'application/json, text/event-stream',
        },
      });
      const resourceMetadataUrl = extractResourceMetadataUrl(response);
      await response.body?.cancel();
      await auth(provider, {
        serverUrl: server.config.url,
        resourceMetadataUrl,
        scope: server.config.oauth.scope,
        fetchFn: oauthFetch,
        forceReauthorization: true,
      });
      if (!authorizationUrl) throw new Error('Missing authorization URL');
      const url = authorizationUrl as URL;
      if (
        url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )
      )
        throw new Error('Insecure authorization URL');
      await this.store.saveSession(
        state,
        server.id,
        userId,
        JSON.stringify({
          namespace,
          binding: oauthBinding(server.config),
          origin,
          returnTo,
          values,
        } satisfies Session),
      );
      return { authorizationUrl: url.toString() };
    } catch {
      throw new McpError('MCP_OAUTH_FAILED', 502);
    }
  }

  async complete(
    userId: string,
    query: { state?: string; code?: string; error?: string; iss?: string },
    getServer: (id: string) => Promise<McpServer>,
  ) {
    if (!query.state || query.state.length > 256)
      throw new McpError('MCP_OAUTH_INVALID_STATE');
    const raw = await this.store.consumeSession(query.state, userId);
    if (!raw) throw new McpError('MCP_OAUTH_INVALID_STATE');
    const session = JSON.parse(raw) as Session;
    if (
      !this.origins.includes(session.origin) ||
      session.namespace.userId !== userId
    )
      throw new McpError('MCP_OAUTH_INVALID_STATE');
    const result = {
      serverId: session.namespace.serverId,
      origin: session.origin,
      returnTo: session.returnTo,
    };
    if (query.error) return { ...result, outcome: 'denied' as const };
    if (!query.code || query.code.length > 8192)
      return { ...result, outcome: 'failed' as const };
    try {
      const server = await getServer(session.namespace.serverId);
      if (
        !server.config.oauth ||
        oauthBinding(server.config) !== session.binding
      )
        throw new McpError('MCP_CONFLICT', 409);
      const namespace = await this.store.namespace(
        server.id,
        session.binding,
        userId,
      );
      if (!namespace || namespace.generation !== session.namespace.generation)
        throw new McpError('MCP_CONFLICT', 409);
      const data: OAuthStorage = {
        get: (key) => session.values[key],
        set: (key, value) => {
          session.values[key] = value;
        },
        delete: (key) => {
          delete session.values[key];
        },
      };
      const provider = this.createProvider(
        data,
        server.config,
        session.origin,
        () => {
          throw new UnauthorizedError();
        },
      );
      await auth(provider, {
        serverUrl: server.config.url!,
        authorizationCode: query.code,
        iss: query.iss,
        fetchFn: oauthFetch,
      });
      // Invalidate in-flight refreshes from the previous account before saving new credentials.
      const stored = this.store.storage(await this.store.rotate(namespace));
      for (const key of [
        'client_info',
        'client_origin',
        'discovery',
        'tokens',
      ]) {
        const value = session.values[key];
        if (value) await stored.set(key, value);
      }
      await stored.delete('needs_auth');
      this.providers.delete(`${server.id}:${userId}`);
      return { ...result, outcome: 'success' as const };
    } catch {
      return { ...result, outcome: 'failed' as const };
    }
  }
}
