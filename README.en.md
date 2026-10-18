# Aime Hub

**A self-hosted AI workspace for personal conversations, shared project files, agents, and scheduled tasks.**

[简体中文](README.md) · **English**

[Product preview](#product-preview) · [Features](#features) · [Quick start](#quick-start) · [Environment variables](#environment-variables) · [Deployment](#deployment) · [Documentation](#documentation)

Aime Hub is built with React, Hono, oRPC, and Mastra, with PostgreSQL storing accounts, configuration, and conversations. Once an administrator connects a model provider, users can chat privately or share conversations and working directories in projects with membership-based access. Conversations run on the server and synchronize over SSE; closing the page does not stop an active conversation.

## Product preview

After starting the app locally, open the **[Home Page](http://127.0.0.1:5173/home)** for interface previews, features, and deployment links. `/home` is public; the existing `/` workspace route is unchanged.

![Aime Hub: AI conversations and workspace](apps/web/public/product/chat-light.jpg)

- **Organize AI around your work**: Explore in personal chats, then bring conversations, members, and shared files together in projects.
- **Choose capabilities for each task**: Switch models and agents, reuse Skills, and connect tools and MCP services.
- **Keep work moving**: Conversations execute on the server and automations run on a schedule, with a consistent interface across light, dark, and mobile views.

Screenshots show actual frontend components with isolated illustrative data, without real accounts or private content. All images live in [`apps/web/public/product/`](apps/web/public/product/README.md) and are shared by the Home Page and README.

## Features

| Capability            | What it provides                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Personal chat         | Streaming responses, Markdown, reasoning display, image input, tool results, paginated history, and message queues          |
| Project collaboration | owner/admin/member roles, membership management, shared conversations, project model settings, and shared workspaces        |
| Model management      | Providers and models, OpenAI-compatible model discovery, capability settings, default models, and reasoning levels          |
| Agents and Skills     | Custom agent management and publishing, batch skill imports from GitHub, and `/` skill discovery in chat                    |
| Tools and MCP         | Configurable web search, web reading, and image generation; Stdio, Streamable HTTP, and SSE MCP connections                 |
| Automations           | Personal, project, and system schedules, pause/resume, manual runs, recent run history, and optional Web Push notifications |
| Workspace files       | File trees, search, uploads, downloads, file operations, and text, image, audio, and video previews                         |
| Administration        | User and session management, request logs, and environment variable records                                                 |
| Bilingual interface   | Simplified Chinese or English based on browser language preferences, with English as the fallback                           |

Tool availability depends on the selected agent, tool configuration, model capabilities, and runtime environment. The administration UI's environment variable records do not modify `.env` or automatically inject values into tool processes.

## Quick start

These steps are for **local development**. For Docker Compose / Dokploy, see [Deployment](#deployment).

### 1. Prepare the environment

- Node.js **≥ 22.13.0** and **pnpm 10.12.1**, as specified in [package.json](package.json).
- Git and a PostgreSQL application database. Use [compose.local.yaml](compose.local.yaml) for PostgreSQL 16 with pgvector locally; [compose.yaml](compose.yaml) is for the full deployment.
- Access to a model provider and its credentials, configured in the administration UI after startup.

```sh
git clone https://github.com/DarkNoah/aime-hub.git
cd aime-hub
pnpm install --frozen-lockfile
cp .env.example .env
openssl rand -base64 32
```

Copy the generated random value into `BETTER_AUTH_SECRET` in `.env` and set `DATABASE_URL` to your database connection string. Minimal configuration (replace the placeholders):

```dotenv
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/aime_hub
BETTER_AUTH_SECRET=<replace-with-generated-secret>
WEB_ORIGINS=http://127.0.0.1:5173
ADMINS=admin
```

Keep the remaining defaults from [.env.example](.env.example) as needed. `.env` and the default `workspaces/` directory are already ignored by Git.

For a local Docker database, keep `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` in `.env` consistent with `DATABASE_URL`, then run `docker compose -f compose.local.yaml up -d`. It listens only on `127.0.0.1:55432` by default and includes pgvector in the image.

### 2. Initialize the database and administrator

Run from the repository root:

```sh
pnpm db:migrate
pnpm auth:create-admin
```

Migrations initialize Better Auth tables before applying TypeORM business migrations. Mastra initializes its `mastra` schema when the API starts, so the database account needs permission to create tables and schemas.

The administrator script prompts for a username, email, and password; the username must be listed in `ADMINS`. **There is no default account or password.** Public registration does not grant administrator access, and changing `ADMINS` does not change existing user roles.

### 3. Start the application

```sh
pnpm dev
```

Open **[http://127.0.0.1:5173](http://127.0.0.1:5173)**. Vite proxies same-origin `/api` requests to `127.0.0.1:3001`, so the browser only needs the frontend entry point. The API health endpoint is `/api/health`.

In development, open the [Scalar API reference](http://127.0.0.1:5173/api/docs); the OpenAPI JSON is available at `/api/openapi.json`. Documentation is generated from the existing oRPC contracts. Responses declared only as TypeScript types have no field details, and standalone Hono routes (such as SSE, file, and authentication endpoints) are not included. Documentation is enabled only in development. `pnpm build` removes its loading logic, so both URLs return 404 in release builds, even if `NODE_ENV=development` is mistakenly set at runtime.

Configure only `WEB_ORIGINS`: a comma-separated list of full HTTP(S) origins. The first entry is the default browser URL and determines the Vite port; Vite does not switch ports automatically. Better Auth uses a dynamic `baseURL` so authentication links follow the trusted request host and protocol, falling back to the first entry when the request host is missing or unmatched. Browser origins must match the list exactly, including scheme, host, and port; unknown origins are still rejected. Restart after changing `.env`. Add the actual IP for LAN access; `0.0.0.0` is a listen address, not a browser entry point. Each host requires its own login and cookies. To migrate, put the previous default origin first in `WEB_ORIGINS`, then remove `WEB_ORIGIN` and `BETTER_AUTH_URL`.

### 4. Connect a model and start chatting

1. Sign in as an administrator and open **Model Providers** (`/admin/providers`).
2. Create a language model provider and enter its Base URL and API Key. Include any required path, such as `/v1`, in the Base URL.
3. Synchronize or manually add models, review image input, tool calling, reasoning, and context length capabilities, and enable the models you want to use.
4. Set the system default model and reasoning level. Send a message in **Personal Chat** (`/threads`), or create a shared workspace under **Projects** (`/projects`).

`OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `DEFAULT_MODEL` in `.env.example` are reserved entries and **do not automatically configure chat models**.

### Optional runtime dependencies

The browser fallback for web reading needs the matching Chromium version. For a source-based installation, run:

```sh
pnpm --filter @aime/server exec playwright-core install chromium
```

Linux also needs Playwright's system libraries. Projects use the local filesystem by default. AgentFS workspaces require the `agentfs` CLI and Linux FUSE or macOS NFS mounting support. The Docker server image includes Chromium, AgentFS, and related tools; the Linux host still needs `/dev/fuse`.

## Usage notes

- **Model selection**: Personal chat resolves the current selection, then personal defaults, then system defaults. Projects use project defaults instead of personal model defaults. A model fixed by an agent takes precedence over the chat model.
- **Agents and MCP**: Create and publish agents at `/admin/agents`, then select them in chat. Configure MCP at `/admin/mcp`; publishing requires a successful connection and tool discovery check.
- **Skills**: Manage personal skills at `/skills` and global skills at `/admin/skills` as an administrator. Import from GitHub, update entire groups from their original branch and path, open source repositories, and preview skill contents. Personal or project skills with the same name override global skills.
- **Conversations and queues**: Closing the page does not stop execution. Stopping the current turn clears pending messages. Pending queues are held in memory and are not restored after a server restart; saved messages remain available.
- **Automations**: Use `/automations`, `/projects/:projectId/automations`, or `/admin/automations`. Schedules follow the server's system timezone and require the server to stay online. Pausing or deleting a task does not cancel a run already in progress.
- **Notifications**: Configure VAPID keys and enable desktop notifications on a task. Browser permission is required, with HTTPS in production; delivery depends on browser and operating system behavior.
- **Data and logs**: Provider keys are currently stored in plaintext in the database. Model request logs contain full request and response content; restrict access to the database, logs, and backups.

For detailed procedures, permissions, and runtime behavior, see the [usage and administration reference (Simplified Chinese)](docs/usage.zh-CN.md).

## Knowledge bases

Manage owned bases under “Created by me” at `/knowledge`, and authorized shared bases under “Shared”. Creators can switch between private, all-user and selected-user sharing. All-user sharing has one permission; selected users each have read or edit permission. Readers can view and search. Editors can add, replace, delete and toggle documents, but cannot change base models or sharing settings. Only the creator can delete a base, including when another user is a system administrator. Sharing changes preserve documents and indexes and are blocked during a rebuild.

Shared membership has no count limit. Member lists and user searches are paginated. Sharing scope and individual permissions are saved immediately; each membership change is submitted independently without replacing other members.

Project bases remain at `/projects/:projectId/knowledge`; members can read and project owners/admins can maintain them. Only the base creator can delete them. Personal conversations retrieve owned and authorized shared bases. Project conversations retrieve only all-user bases and the current project, excluding private and individually shared sources. Permissions are checked again before search results are returned.

Import text, webpage URLs, TXT, Markdown, HTML, JSON, CSV, PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP and RTF files (up to 10 MB each). Document extraction uses `officeparser` and feeds the [official Mastra RAG pipeline](https://mastra.ai/reference/rag/chunking-and-embedding): `MDocument.chunk()` → AI SDK `embedMany()` → `PgVector`. Scanned PDFs require OCR first. Original uploads and processing states persist in PostgreSQL; interrupted imports resume after restart and failed imports can be retried. Inspect extracted text and chunks, enable/disable sources, and test retrieval in the UI.

Retrieval runs **vector + BM25 recall → RRF candidate selection → final rerank ordering**. BM25 uses the official Mastra `Workspace` with Chinese/English tokenization; vectors use `PgVector`. Recall RRF sums each route's `1 / (60 + rank)` by chunk ID and selects `max(20, topK × 4)` candidates, capped at 400. Mastra `rerankWithScorer()` orders these candidates solely by rerank scores before selecting topK; rerank ranks no longer contribute to RRF. Finite negative scores and scores above 1 are valid, and ties preserve recall order. Vector failures/timeouts retain BM25. Without a reranker, recall RRF order is retained; a timeout, invalid response or request failure restores the entire recall RRF order. The vector stage has a 10-second deadline; reranking has 60 seconds. `score` is the final sorting score: `scores.rerank` on success, otherwise `scores.rrf`. `scores.rrf` always retains the recall fusion score. These scores are not relevance probabilities.

Each request builds the BM25 in-memory index in batches from authorized, enabled database sources. No additional database extension or migration is needed; larger corpora increase indexing latency and memory. Cross-base searches use one authorized BM25 corpus. Vector results using the same embedding model and dimension are merged by cosine similarity and truncated to one shared candidate window before recall RRF, so every base does not receive its own first-place vector contribution. Different embedding spaces retain separate recall rankings without comparing raw similarity scores. Single-base searches honor that base's reranker, including disabled reranking. Cross-base searches use the system default reranker for all candidates. Without a default, the sole configured rerank model across the bases scores all candidates, including bases without their own reranker; if none is configured, recall order is retained. Multiple configured models without a default trigger a whole-request recall RRF fallback with `model_conflict`, prompting configuration of a default reranker. Permissions and enabled states are checked again before returning results.

New bases preselect the system default embedding and rerank models, then save independent references; later system-default changes do not alter existing bases. Changing either model rebuilds every chunk vector, including disabled sources. A durable database job and write guards block imports, edits, deletion, toggles and duplicate rebuilds on that base while other bases remain writable. Searches continue using the original model and index. All embeddings are first computed into a temporary file; only then is a separate index written and its count/dimension verified. A transaction publishes both model references and the index pointer together. Failure preserves the previous data and unlocks the base; save the target models again to retry. Interrupted rebuilds resume after restart. Pending document imports must finish before changing models.

Editing a document reprocesses and re-embeds it without incrementing its version. **Update version** preserves the previous original file, parsed text, tags and metadata, then replaces the source and increments the version. History supports text/metadata diffs and original-file downloads. Documents record creator/update timestamps. Deletion archives a document, preserving its history and excluding it from search; restoring reprocesses it with the current model.

Chunks, embeddings and physical custom columns share one per-base table: `knowledge_<nanoid>_<dimension>` (`0` for BM25 only). There is no separate `knowledge_chunks` table. Creation supports text, number, boolean, date, json and blob columns. Metadata filters and multidimensional tags apply to both recall routes and the final access check; tags use OR within a dimension and AND across dimensions.

The aime-chat-compatible toolkit retains existing tool IDs and independent admin toggles:

- `knowledge_create`: embeddingModel, rerankerModel and extendColumns; omitted models use defaults, null/empty string disables them.
- `knowledge_list`: accessible bases, permissions, models, item counts and custom columns.
- `knowledge_search`: kb_source IDs/names, top_k, safe parameterized where expressions, tags/metadata and bounded return_full_content.
- `knowledge_get_document`: item_id, text/json, safe grep pattern, offset/limit, version/history; filtering precedes pagination and preserves original line numbers.
- `knowledge_save_document`: kb_source, item_id, text/file/folder/web sources and partial extendColumns updates; save/update_version/archive/restore/reprocess actions. Version updates require expectedVersion. Workspace folder imports report per-file results.

Legacy baseId/documentId/topK/source-object inputs remain supported. Tools use trusted conversation identity and the same permissions/rebuild locks as the UI. Run `pnpm db:migrate` before upgrading; the transactional migration copies and verifies chunks/vectors before dropping legacy tables. PostgreSQL must support pgvector.

## Environment variables

Configure `.env` at the repository root. Authentication and business APIs share the origin allowlist; wildcards are not supported.

| Variable                                       | Configuration                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                 | Required PostgreSQL connection string                                                                             |
| `BETTER_AUTH_SECRET`                           | Required random authentication secret, at least 32 characters                                                     |
| `WEB_ORIGINS`                                  | Required comma-separated origins; the first is the default entry and determines the Vite port                     |
| `WEB_HOST`                                     | Vite listen address; defaults to `0.0.0.0`                                                                        |
| `SERVER_HOST` / `SERVER_PORT`                  | API listen address and port; defaults to `0.0.0.0:3001`                                                           |
| `ADMINS`                                       | Comma-separated reserved administrator usernames; defaults to `admin`; provisioning still requires the script     |
| `WORKSPACE_ROOT`                               | Root for files and skills; defaults to `workspaces`; relative paths resolve from the repository command directory |
| `NODE_ENV`                                     | Defaults to `development`; use `production` in production                                                         |
| `ALLOW_INSECURE_HTTP`                          | Defaults to `false`; explicitly set `true` only for temporary HTTP access on a trusted private network            |
| `WEB_PUSH_PUBLIC_KEY` / `WEB_PUSH_PRIVATE_KEY` | Optional Web Push VAPID key pair; keep it stable                                                                  |
| `WEB_PUSH_SUBJECT`                             | Set when enabling push: an HTTPS contact page or `mailto:` address                                                |
| `TZ`                                           | Service process timezone; Compose defaults to `Asia/Shanghai`, while source-based runs use the system timezone    |
| `TEST_DATABASE_URL`                            | Optional dedicated test database; integration tests that require it are skipped when unset                        |

Generate push keys with:

```sh
pnpm --filter @aime/server exec web-push generate-vapid-keys --json
```

Compose also requires `POSTGRES_PASSWORD`. It constructs `DATABASE_URL` inside the container and passes `WEB_ORIGINS` to the API. See the [deployment guide (Simplified Chinese)](docs/deployment.md) for image overrides and private-network port settings.

## Deployment

Use **Docker Compose / Dokploy**, or host the build artifacts yourself. The recommended topology is **one API instance + PostgreSQL + a persistent workspace directory + a same-origin frontend entry point**.

### Docker Compose / Dokploy

The [Dockerfile](Dockerfile) builds API and Nginx images; [compose.yaml](compose.yaml) starts only three application services by default: `server`, `web`, and `app-postgres`. It loads no E2B services and requires no E2B configuration.

- Set `WEB_ORIGINS`, `POSTGRES_PASSWORD`, and `BETTER_AUTH_SECRET`, and route an HTTPS entry point to `web:80`. Application ports are container-only.
- The API container runs `pnpm db:migrate` on startup. Then run `pnpm auth:create-admin` inside the `server` container.
- PostgreSQL and workspaces use the `postgres-data` and `workspace-data` named volumes. Back up both.
- The `server` FUSE configuration requires `/dev/fuse` on the Linux host and the configured privileges, including `SYS_ADMIN`.
- For temporary direct access on a private network, use the [compose.ip.yaml](compose.ip.yaml) override. Full configuration and Dokploy instructions are in the [deployment guide (Simplified Chinese)](docs/deployment.md).

### Optional self-hosted E2B Desktop

Explicitly load [compose.e2b.yaml](compose.e2b.yaml) to deploy the official E2B Embed management API, Firecracker orchestrator, proxy, dashboard, databases, and initialization services. It automatically builds the `desktop` template from a pinned official desktop image. Use a **dedicated x86-64 Linux/KVM host**; Ubuntu 24.04, at least 12 GiB RAM and 20 GiB free disk, Docker ≥ 27, and Compose ≥ 2.24 are recommended/required as detailed in the [E2B deployment guide](docker/e2b/README.md). This desktop image cannot run as a Firecracker guest on an ARM Docker host. Setup configures host KVM, networking, and hugepages.

Set `E2B_API_KEY` in `.env` or Dokploy to `e2b_` followed by at least 32 random hexadecimal characters (generate with `printf 'e2b_'; openssl rand -hex 32`), then run:

```sh
docker compose -f compose.yaml -f compose.e2b.yaml up -d --build --wait
```

The first start downloads runtime artifacts and builds the desktop template. The backend automatically connects to `http://host.docker.internal:3000` using the same key as E2B's seed service. **Administration → Settings → E2B Desktop** shows “Deployment configuration”; connection testing and instance management work without entering the URL or key again. Deployment environment variables own the connection settings, and the key is never returned to the browser.

Create instances, edit their lifetime, and delete them from the manager. Only sandboxes tagged `managedBy=desktop-admin` are managed. Editing resets expiry from submission time; templates and creation names cannot be changed in place. Desktops start XFCE at 1280×720. Agent control is not connected yet. Restrict E2B's internal host ports, especially unauthenticated `5008`, to the trusted host; see the deployment guide's port table.

Application data keeps using `postgres-data` and `workspace-data`; E2B has separate database volumes and host directories. Keep the Compose project name unchanged during upgrades and do not use `down -v`. The previous standalone desktop's data is not migrated into sandboxes.

With the default Compose deployment, configure an existing E2B management API in the admin UI without loading any self-hosted E2B services. For local development or separately hosted applications, `E2B_API_URL` and `E2B_API_KEY` can also inject the connection configuration. Required endpoints are `GET/POST /v2/sandboxes`, `GET/DELETE /sandboxes/{id}`, and `POST /sandboxes/{id}/timeout`.

### Self-managed hosting

Configure a production `.env` at the root with `NODE_ENV=production`, HTTPS authentication URLs, and the origin allowlist, then run:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pnpm start
```

On first deployment, also run `pnpm auth:create-admin`. `pnpm start` **starts only the API**. Host `apps/web/dist` separately, provide an `index.html` fallback for SPA routes, and proxy same-origin `/api/*` requests to the API. `SERVER_HOST` controls the listen address and defaults to `0.0.0.0`; set it explicitly to `127.0.0.1` when using a reverse proxy on the same host.

Use the [Nginx configuration](apps/web/nginx.conf) as a reference for disabling SSE buffering and setting long connection timeouts. Queues, scheduling, and some state are process-local; do not run multiple API replicas. Forwarded headers are not trusted by default, so login rate limits behind a reverse proxy may share the proxy address's quota.

## Development

Frontend: React 19, Vite 7, TanStack Router, Tailwind CSS 4, shadcn/ui, AI Elements, and i18next. Backend: Hono, oRPC, Mastra, and Better Auth. Data: PostgreSQL, TypeORM business migrations, and Mastra persistence. The repository uses pnpm workspaces and TypeScript.

| Command                             | Purpose                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `pnpm dev`                          | Start the API and Vite together                                           |
| `pnpm db:migrate`                   | Initialize authentication tables and apply business migrations            |
| `pnpm auth:create-admin`            | Create an administrator interactively                                     |
| `pnpm typecheck`                    | Check workspace and script types                                          |
| `pnpm lint`                         | Run ESLint                                                                |
| `pnpm format:check` / `pnpm format` | Check formatting / write formatted files                                  |
| `pnpm test`                         | Run tests; database integration tests need their connection configuration |
| `pnpm build`                        | Build the API and frontend                                                |
| `pnpm start`                        | Start the built API                                                       |
| `pnpm providers:catalog`            | Update the provider capability catalog                                    |

Use a separate database for integration tests, for example:

```sh
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/aime_hub_test pnpm test
```

The test account needs permission to create schemas. Mock model tests do not establish compatibility with real providers; validate image, reasoning, and long-context behavior separately for each provider. VS Code users can use the included [full-stack debugging configuration](.vscode/launch.json).

## Project structure

```text
apps/
├── web/src/           # Pages, reusable components, routing, and Chinese/English translations
└── server/src/        # Business modules, RPC, Mastra agents, and tools
packages/
├── auth/              # Better Auth configuration and authentication migrations
├── db/                # TypeORM business entities and migrations
└── shared/            # Shared types, validation, environment loading, and RPC contracts
scripts/               # Administrator provisioning, migrations, tests, and catalog updates
docs/                  # Usage, deployment, architecture, and module documentation
```

Business API contracts live in `packages/shared/src/rpc/`, and page routes in `apps/web/src/router.tsx`. API startup checks for pending migrations without automatically changing authentication or business schemas; the container entry point runs migrations separately.

## Troubleshooting

| Problem                               | What to check                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Login or API origin errors            | Match the actual browser origin to `WEB_ORIGINS`, then restart                                   |
| Invalid environment configuration     | Check the variables listed in the error, especially required values and secret length            |
| Database connection or schema errors  | Check the connection and database permissions, then run `pnpm db:migrate`                        |
| The page loads but chat does not work | Configure a provider, enable a model, and set a default model in the administration UI           |
| Imported skills are missing           | Check `WORKSPACE_ROOT`, `SKILL.md`, the selected agent, and skill scope                          |
| AgentFS mount failures                | Check the CLI, Linux FUSE / macOS NFS, and mount permissions, or use the default local workspace |
| Development port is occupied          | Stop the conflicting process, or update the entry URL and origin allowlist together              |

Email verification, password recovery, and email delivery are not implemented. Registration email addresses are used only as account identifiers.

## Documentation

The detailed documentation below is currently primarily in Simplified Chinese:

- [Usage and administration reference](docs/usage.zh-CN.md): MCP, automations, agents, Skills, models, tools, notifications, and request logs.
- [Deployment guide](docs/deployment.md): Docker Compose, Dokploy, persistence, and private-network access.
- [Architecture](docs/architecture.md) · [Personal chat](docs/personal-chat.md) · [Project collaboration](docs/projects.md)
- [Model providers](docs/模型供应商模块.md) · [Agent execution](docs/harness.md) · [exec tool](docs/exec-tool.md)
- [Product requirements](docs/PRD.md) · [Development conventions](AGENTS.md)

## License

The repository currently has no `LICENSE` file or license declaration in its root `package.json`. Contact the maintainer to confirm the terms before using, modifying, or distributing the project.
