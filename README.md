# Aime Hub

**可自行部署的 AI 工作空间：将个人对话、项目共享文件、Agent 与定时任务放在一起。**

**简体中文** · [English](README.en.md)

[产品预览](#产品预览) · [功能](#功能) · [快速开始](#快速开始) · [环境变量](#环境变量) · [部署](#部署) · [文档](#文档)

Aime Hub 基于 React、Hono、oRPC 和 Mastra 构建，使用 PostgreSQL 保存账号、配置与对话。管理员接入模型供应商后，用户可以进行个人聊天，也可以在有成员权限控制的项目中共享对话和工作目录。对话由服务端执行、通过 SSE 同步，关闭页面不会停止正在运行的对话。

## 产品预览

本地启动后打开 **[Home Page](http://127.0.0.1:5173/home)**，查看产品界面、核心特点与部署入口。`/home` 无需登录，原有 `/` 工作区入口保持不变。

![Aime Hub：AI 对话与工作空间](apps/web/public/product/chat-light.jpg)

- **围绕工作组织 AI**：个人对话用于探索，项目将讨论、成员与共享文件放在一起。
- **按任务组合能力**：选择模型与 Agent，复用 Skills，通过工具与 MCP 连接外部能力。
- **让工作持续推进**：对话在服务端运行，自动化按计划执行；浅色、深色与移动端使用同一套交互。

截图使用真实前端组件与隔离的示例数据，不包含真实账号或私有内容。图片统一存放于 [`apps/web/public/product/`](apps/web/public/product/README.md)，由 Home Page 与 README 共用。

## 功能

| 能力            | 可以做什么                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| 个人聊天        | 流式回复、Markdown、推理展示、图片输入、工具结果、历史分页与消息队列              |
| 项目协作        | owner/admin/member 角色、成员管理、共享对话、项目模型配置与共享工作区             |
| 模型管理        | 管理供应商与模型、同步 OpenAI 兼容模型列表、配置能力、默认模型与思考等级          |
| Agent 与 Skills | 管理和发布自定义 Agent，从 GitHub 批量导入技能，在聊天中用 `/` 查找技能           |
| 工具与 MCP      | 配置网页搜索、网页读取及图片生成工具；管理 Stdio、Streamable HTTP 和 SSE MCP 连接 |
| 自动化          | 个人、项目和系统定时任务，启停、立即运行、最近运行记录与可选 Web Push 通知        |
| 工作区文件      | 文件树、搜索、上传、下载、文件操作及文本、图片、音视频预览                        |
| 管理后台        | 用户与会话管理、请求日志、环境变量记录管理                                        |
| 双语界面        | 根据浏览器语言选择简体中文或英文，未匹配时回退英文                                |

工具可用性取决于所选 Agent、工具配置、模型能力及运行环境。后台环境变量会在每次启动沙盒命令时注入，不会修改 `.env`；已运行的进程保留启动时的环境。

命令工具 `exec_command` 接收必填 `cmd`，以及可选 `workdir`（默认当前会话目录）、`shell`（默认用户 Shell）、`login`（默认 `true`）、`tty`（默认 `false`）、`yield_time_ms`（默认 10000，范围 250–30000 毫秒）和 `max_output_tokens`（默认 10000，上限 100000，按每 token 约 4 UTF-8 字节估算）。超过等待时间只返回控制权，进程继续运行，并返回 `session_id`。

使用 `write_stdin` 继续输入或读取新增输出：

```json
{ "session_id": 123, "chars": "my-app\n" }
{ "session_id": 123, "chars": "", "yield_time_ms": 1000 }
```

`write_stdin` 也支持 `max_output_tokens`；`chars` 默认为空，等待时间与输出预算的默认值和范围同 `exec_command`。交互式 CLI 请用 `tty: true` 启动，之后可发送 `\u0003`（Ctrl-C）中断或 `\u0004`（Ctrl-D）结束输入。返回 `exit_code` 表示进程已结束；同一会话只返回新增输出，截断时标记 `truncated`。最多保留 32 个命令会话，每个最多缓存 1 MiB 输出，退出后未读取的结果最多保留 10 分钟。会话绑定当前聊天的 Workspace，关闭 Workspace 或重启服务后失效。两个工具均可在后台工具设置中启用或停用，并支持 Agent 排除配置。

聊天顶部的“后台任务”入口同时显示 Mastra 后台任务和命令进程。命令列表实时展示命令、工作目录、会话 ID、PID、PTY 与退出状态；可“停止并清理”运行中的进程，或“释放结果”丢弃已退出会话的未读输出。清理仅作用于当前聊天的命令会话。运行中的命令会阻止聊天闲置回收，关闭页面后仍继续；全部退出或清理后恢复正常回收。服务重启仍会终止进程，不支持跨重启恢复。

PTY 使用固定版本 `node-pty@1.2.0-beta.15`，该上游版本包含 macOS 辅助程序执行权限修复；Linux 安装可能需要 Python 和 C++ 编译工具，Docker 构建阶段已包含这些依赖。

## 快速开始

以下是**本地开发**流程。Docker Compose / Dokploy 部署请见[部署](#部署)。

### 1. 准备环境

- Node.js **≥ 22.12.0**、**pnpm 10.12.1**（以 [package.json](package.json) 为准）。
- Git，以及 PostgreSQL 应用数据库。可通过 [compose.local.yaml](compose.local.yaml) 启动带 pgvector 的 PostgreSQL 16；[compose.yaml](compose.yaml) 用于完整部署。
- 可访问的模型供应商与相应凭据，在启动后通过管理后台配置。

```sh
git clone https://github.com/DarkNoah/aime-hub.git
cd aime-hub
pnpm install --frozen-lockfile
cp .env.example .env
openssl rand -base64 32
```

将最后一条命令生成的随机值填入 `.env` 的 `BETTER_AUTH_SECRET`，并将 `DATABASE_URL` 改为实际连接串。最小配置示例（请替换占位值）：

```dotenv
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/aime_hub
BETTER_AUTH_SECRET=<replace-with-generated-secret>
WEB_ORIGINS=http://127.0.0.1:5173
ADMINS=admin
```

其他选项可保留 [.env.example](.env.example) 的默认值。`.env` 与默认 `workspaces/` 已被 Git 忽略。

使用本地 Docker 数据库时，保持 `.env` 中的 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB` 与 `DATABASE_URL` 一致，然后执行 `docker compose -f compose.local.yaml up -d`。默认仅监听 `127.0.0.1:55432`，镜像内置 pgvector。

### 2. 初始化数据库与管理员

在仓库根目录执行：

```sh
pnpm db:migrate
pnpm auth:create-admin
```

迁移先初始化 Better Auth 认证表，再执行 TypeORM 业务迁移。Mastra 在 API 启动时初始化 `mastra` schema，因此数据库账号需要建表和创建 schema 的权限。

管理员脚本会询问用户名、邮箱和密码；用户名必须包含在 `ADMINS` 中。**没有默认账号或默认密码。** 公开注册不会授予管理员权限，修改 `ADMINS` 也不会改变已有用户角色。

### 3. 启动并打开网页

```sh
pnpm dev
```

访问 **[http://127.0.0.1:5173](http://127.0.0.1:5173)**。Vite 将同域 `/api` 请求代理到 `127.0.0.1:3001`，浏览器只需访问前端入口。API 健康检查为 `/api/health`。

只需配置 `WEB_ORIGINS`，多个完整 HTTP(S) 来源用逗号分隔，第一项是默认浏览器入口并决定 Vite 端口；端口被占用时不会自动切换。Better Auth 使用动态 `baseURL`，认证链接跟随受信任请求的访问地址；没有请求地址或主机未匹配时回退到第一项。浏览器来源必须精确匹配列表中的协议、主机与端口，未知来源仍会被拒绝。修改 `.env` 后重启服务。需要局域网访问时，将实际 IP 加入列表，不要将监听地址 `0.0.0.0` 当作浏览器入口。不同主机分别登录，不共享 Cookie。旧配置迁移时，把原默认入口放到 `WEB_ORIGINS` 第一项，然后删除 `WEB_ORIGIN` 和 `BETTER_AUTH_URL`。

### 4. 接入模型，开始对话

1. 登录管理员账号，打开 **模型供应商**（`/admin/providers`）。
2. 创建语言模型供应商，填写 Base URL 和 API Key；Base URL 应包含供应商要求的 `/v1` 等路径。
3. 同步或手动添加模型，核对图片输入、工具调用、推理和上下文长度等能力，启用要使用的模型。
4. 设置系统默认模型与思考等级，在 **个人聊天**（`/threads`）发送消息，或在 **项目**（`/projects`）创建共享工作区。

`.env.example` 中的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `DEFAULT_MODEL` 是预留项，**不会自动配置聊天模型**。

### 可选运行依赖

网页读取的浏览器兜底需要对应版本的 Chromium，可在源码环境执行：

```sh
pnpm --filter @aime/server exec playwright-core install chromium
```

Linux 还需安装 Playwright 所需的系统库。项目默认使用本地文件系统；选择 AgentFS 工作区时，需安装 `agentfs` CLI，并提供 Linux FUSE 或 macOS NFS 挂载支持。Docker 服务镜像已包含 Chromium、AgentFS 和相关工具，Linux 宿主机仍需提供 `/dev/fuse`。

## 使用要点

- **模型选择**：个人聊天按当前选择、个人默认、系统默认解析；项目使用项目默认配置，不继承个人模型默认。Agent 固定模型优先于聊天模型。
- **Agent 与 MCP**：在 `/admin/agents` 创建并发布 Agent，在聊天中选择；MCP 在 `/admin/mcp` 配置，发布前需通过连接与工具发现检查。
- **Skills**：在左上方的 `/skills` 管理个人技能，管理员在 `/admin/skills` 管理全局技能。支持 GitHub 导入、按原分支与路径整组更新、仓库跳转及内容预览；个人或项目同名技能可覆盖全局技能。
- **会话与队列**：关闭网页不停止执行；停止当前轮次会清空待处理消息。待处理队列在内存中，服务重启后不会恢复；已保存消息仍可查看。
- **自动化**：入口为 `/automations`、`/projects/:projectId/automations` 和 `/admin/automations`。按服务端系统时区运行，服务器需保持在线；暂停或删除任务不会取消已经开始的运行。
- **通知**：可配置 VAPID 密钥并开启任务桌面通知。需要浏览器授权，生产环境需 HTTPS；推送到达受浏览器和操作系统影响。
- **数据与日志**：供应商密钥目前以明文保存在数据库，模型请求日志包含完整请求与响应内容；需保护数据库、日志与备份的访问权限。

详细步骤、权限边界及运行行为见[使用与管理参考](docs/usage.zh-CN.md)。

## 环境变量

在仓库根目录配置 `.env`。认证与业务 API 共用来源白名单，不支持通配符。

| 变量                                           | 配置说明                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`                                 | 必填，PostgreSQL 连接串                                          |
| `BETTER_AUTH_SECRET`                           | 必填，至少 32 字符的随机认证密钥                                 |
| `WEB_ORIGINS`                                  | 必填，逗号分隔的来源白名单；第一项为默认入口并决定 Vite 端口     |
| `WEB_HOST`                                     | Vite 监听地址，默认 `0.0.0.0`                                    |
| `SERVER_HOST` / `SERVER_PORT`                  | API 监听地址与端口，默认 `0.0.0.0:3001`                          |
| `ADMINS`                                       | 保留管理员用户名，逗号分隔，默认 `admin`；需运行初始化脚本       |
| `WORKSPACE_ROOT`                               | 文件与技能根目录，默认 `workspaces`；相对路径从仓库命令目录解析  |
| `NODE_ENV`                                     | 默认 `development`，生产环境设为 `production`                    |
| `ALLOW_INSECURE_HTTP`                          | 默认 `false`；仅为可信内网临时 HTTP 访问显式设为 `true`          |
| `WEB_PUSH_PUBLIC_KEY` / `WEB_PUSH_PRIVATE_KEY` | 可选，Web Push VAPID 密钥对；应保持稳定                          |
| `WEB_PUSH_SUBJECT`                             | 启用推送时设置，HTTPS 联系页面或 `mailto:` 邮箱                  |
| `TZ`                                           | 服务进程时区；Compose 默认 `Asia/Shanghai`，源码运行使用系统时区 |
| `TEST_DATABASE_URL`                            | 可选，专用测试数据库；未设置时跳过需要它的集成测试               |

生成推送密钥：

```sh
pnpm --filter @aime/server exec web-push generate-vapid-keys --json
```

Compose 还需要 `POSTGRES_PASSWORD`，并在容器内生成 `DATABASE_URL`，将 `WEB_ORIGINS` 传给 API。镜像覆盖及内网端口等部署变量见[部署说明](docs/deployment.md)。

## 部署

支持 **Docker Compose / Dokploy**，也可以自行托管构建产物。推荐拓扑为：**一个 API 实例 + PostgreSQL + 持久工作目录 + 同域前端入口**。

### Docker Compose / Dokploy

[Dockerfile](Dockerfile) 构建 API 与 Nginx 镜像；[compose.yaml](compose.yaml) 提供 `server`、`web` 和 `postgres` 服务。

- 配置 `WEB_ORIGINS`、`POSTGRES_PASSWORD`、`BETTER_AUTH_SECRET`，并将 HTTPS 入口路由至 `web:80`。基础 Compose 仅暴露容器端口，不映射宿主机端口。
- API 容器启动时执行 `pnpm db:migrate`；启动后在 `server` 容器中执行 `pnpm auth:create-admin`。
- PostgreSQL 与工作区分别使用 `postgres-data`、`workspace-data` 命名卷，应一起备份。
- `server` 的 FUSE 配置需要 Linux 宿主机提供 `/dev/fuse`，并使用配置中的 `SYS_ADMIN` 等权限。
- 临时内网直连使用 [compose.ip.yaml](compose.ip.yaml) 覆盖文件；完整配置与 Dokploy 操作见[部署说明](docs/deployment.md)。

### 自行托管

在根目录配置生产 `.env`（`NODE_ENV=production`、HTTPS 认证地址与来源白名单），然后执行：

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pnpm start
```

首次部署还需运行 `pnpm auth:create-admin`。`pnpm start` **仅启动 API**；需另行托管 `apps/web/dist`，为 SPA 提供 `index.html` 回退，并将同域 `/api/*` 代理至 API。监听地址由 `SERVER_HOST` 控制，默认 `0.0.0.0`；同机反向代理场景可显式设为 `127.0.0.1`。

参考 [Nginx 配置](apps/web/nginx.conf) 为 SSE 关闭缓冲并配置长连接超时。队列、调度和部分状态由单进程持有，当前不要运行多个 API 副本。默认不信任转发头，反向代理后的登录限流可能共享代理地址额度。

## 开发

前端：React 19、Vite 7、TanStack Router、Tailwind CSS 4、shadcn/ui、AI Elements、i18next。后端：Hono、oRPC、Mastra、Better Auth。数据：PostgreSQL、TypeORM 业务迁移与 Mastra 持久化。工程使用 pnpm workspace 和 TypeScript。

| 命令                                | 用途                                     |
| ----------------------------------- | ---------------------------------------- |
| `pnpm dev`                          | 同时启动 API 与 Vite                     |
| `pnpm db:migrate`                   | 初始化认证表并执行业务迁移               |
| `pnpm auth:create-admin`            | 交互创建管理员                           |
| `pnpm typecheck`                    | 检查工作区与脚本类型                     |
| `pnpm lint`                         | ESLint 检查                              |
| `pnpm format:check` / `pnpm format` | 检查格式 / 写入格式化结果                |
| `pnpm test`                         | 运行测试；数据库集成测试需要相应连接配置 |
| `pnpm build`                        | 构建 API 与前端                          |
| `pnpm start`                        | 启动已构建 API                           |
| `pnpm providers:catalog`            | 更新供应商能力目录                       |

数据库集成测试使用独立数据库，例如：

```sh
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/aime_hub_test pnpm test
```

测试账号需有创建 schema 的权限。模拟模型测试不等于真实供应商验收；图片、推理与长上下文等能力需按供应商另行验证。VS Code 用户可使用仓库内的[全栈调试配置](.vscode/launch.json)。

## 项目结构

```text
apps/
├── web/src/           # 页面、复用组件、路由与中英文翻译
└── server/src/        # 业务模块、RPC、Mastra Agent 与工具
packages/
├── auth/              # Better Auth 配置与认证迁移
├── db/                # TypeORM 业务实体与迁移
└── shared/            # 共享类型、校验、环境加载与 RPC 契约
scripts/               # 管理员初始化、迁移、测试与目录更新
docs/                  # 使用、部署、架构与模块说明
```

业务接口契约位于 `packages/shared/src/rpc/`，页面路由位于 `apps/web/src/router.tsx`。API 启动时检查待执行迁移，不会自动修改认证或业务表结构；容器入口单独执行迁移。

## 常见问题

| 问题                       | 检查方向                                                          |
| -------------------------- | ----------------------------------------------------------------- |
| 登录或 API 提示来源错误    | 核对实际浏览器来源与 `WEB_ORIGINS`，修改后重启                    |
| 提示环境配置无效           | 检查报错列出的变量，尤其是必填项与认证密钥长度                    |
| 数据库连接失败或结构未就绪 | 检查数据库连接与权限，并执行 `pnpm db:migrate`                    |
| 网页能打开但无法聊天       | 在后台配置供应商，启用模型并设置默认模型                          |
| 刚导入的技能不可见         | 核对 `WORKSPACE_ROOT`、`SKILL.md`、所选 Agent 与技能作用域        |
| AgentFS 挂载失败           | 检查 CLI、Linux FUSE / macOS NFS 和挂载权限，或使用默认本地工作区 |
| 开发端口被占用             | 停止占用进程，或同步调整入口地址与来源白名单                      |

当前未实现邮件验证、找回密码或邮件发送；注册邮箱仅作为账号标识。

## 文档

以下详细文档当前以简体中文为主：

- [使用与管理参考](docs/usage.zh-CN.md)：MCP、自动化、Agent、Skills、模型、工具、通知与请求日志。
- [部署说明](docs/deployment.md)：Docker Compose、Dokploy、持久化与内网访问。
- [架构](docs/architecture.md) · [个人聊天](docs/personal-chat.md) · [项目协作](docs/projects.md)
- [模型供应商](docs/模型供应商模块.md) · [Agent 执行规范](docs/harness.md) · [exec 工具](docs/exec-tool.md)
- [产品需求](docs/PRD.md) · [开发约定](AGENTS.md)

## 许可证

仓库目前未提供 `LICENSE` 文件，也未在根 `package.json` 中声明许可证。使用、修改或分发前，请向维护者确认授权条款。
