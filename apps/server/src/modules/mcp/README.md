# MCP OAuth

HTTP / SSE connections can enable OAuth in the MCP editor. Publish the configuration, then each user signs in independently. Published connections reconnect for that user after authorization. Stdio and static header authentication remain available.

- Supports dynamic client registration, or a pre-registered **public** OAuth client using the optional Client ID. Confidential clients requiring a manually supplied client secret are not configured by this UI.
- The callback is `<web-origin>/api/mcp/oauth/callback`. The initiating origin must appear in `WEB_ORIGINS`. Registration uses only the initiating origin's callback, so unrelated development origins do not invalidate native/loopback client registration. Switching origins registers a compatible client when necessary; refresh reuses the registered origin after restart. Production origins should use HTTPS.
- Authorization and runtime connections are isolated by user and MCP ID. Callbacks require the initiating user's signed-in account, an unexpired one-use state, and the PKCE verifier. Sessions expire after ten minutes and survive application restarts. Starting a new flow replaces the previous pending flow for that user and server.
- Credentials and pending authorization sessions are encrypted with AES-256-GCM using a purpose-specific key derived from `BETTER_AUTH_SECRET`. They are stored in separate PostgreSQL tables, never in the MCP configuration/API response. Keep that secret stable across restarts; after rotating it, clear saved authorization and sign in again.
- Tokens refresh on use shortly before their advertised expiry; a resource-server 401 also triggers the SDK refresh flow. Refresh tokens are retained when the provider omits a replacement. If refresh is rejected, the UI shows that sign-in is required. Providers must issue a refresh token to permit renewal without another login.
- Changing the endpoint, OAuth client/scopes, or headers clears the old credentials. Clearing local authorization deletes only the current user’s tokens and pending sessions and disconnects their client; it does not revoke consent at the external provider.

The built-in `request_authorization` tool accepts `mcpId` and an optional `reason`. Without an ID it lists published OAuth services. It suspends the agent and displays a sign-in card outside collapsed message details. The card opens browser authorization and returns to the conversation; resume verifies the current user’s saved authorization before the agent rediscovers MCP tools. Credentials, PKCE verifiers and authorization codes never enter model messages. OAuth clients reconnect lazily per user after restart.

Run `pnpm db:migrate` before starting the updated server. The migration creates `mcp_oauth_credentials` and `mcp_oauth_sessions`.

Verification:

```sh
node --import tsx --test apps/server/src/modules/mcp/*.test.ts apps/web/src/pages/admin/mcp/config.test.ts
# Set TEST_DATABASE_URL to an isolated test database to also exercise PostgreSQL persistence and the migration.
```
