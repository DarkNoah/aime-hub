# Aime Hub

基于 React、TanStack Router、Hono、oRPC 和 Mastra 的 AI 工作空间，支持个人对话、项目协作、模型供应商管理与会话工作目录。消息由服务端持续执行，通过 SSE 同步；关闭页面不会中断正在进行的对话。

## 功能

| 模块       | 当前能力                                                                             |
| ---------- | ------------------------------------------------------------------------------------ |
| 账号与权限 | 用户名登录、注册、持久会话；管理员管理用户、角色、密码、封禁与会话撤销               |
| 模型管理   | 供应商与模型管理、OpenAI 兼容模型列表同步、能力配置、系统默认模型与思考等级          |
| 个人聊天   | 流式回复、Markdown、推理过程、图片输入、工具结果、上下文用量、错误重试与历史分页     |
| 消息队列   | Mastra 原生 FIFO 队列，通过取消重入队支持编辑、排序，支持清空与停止                  |
| 工具交互   | 工具审批、用户问题与挂起恢复；后台任务状态、结果展示和单独取消                       |
| 项目协作   | owner/admin/member 角色、成员管理、共享对话、项目默认模型与共享工作目录              |
| 工作区文件 | 文件树、文件名与内容搜索、新建、重命名、删除、下载，文本/代码及图片、音频、视频预览  |
| Skills     | 后台扫描 GitHub 并批量安装技能，支持全局及个人/项目覆盖，输入 `/` 搜索并补全技能命令 |
| 界面       | 中英文随浏览器语言切换、响应式导航、可调整宽度的文件/消息检查面板、全局会话运行状态  |

## 技术栈

- **前端**：React 19、Vite 7、TanStack Router 1、TypeScript、Tailwind CSS 4、shadcn/ui、AI Elements、AI SDK 6、Streamdown、i18next。
- **后端**：Hono 4（Node.js adapter）、oRPC 1、Mastra Agent / Memory / Workspace / Background Tasks。
- **认证**：Better Auth，使用 `username` 与 `admin` 插件。
- **存储**：PostgreSQL；TypeORM 管理业务实体和迁移，Mastra 管理线程、消息与任务持久化。
- **工程**：pnpm workspace、ESLint、Prettier、Node.js 测试运行器。

## 快速开始

### 1. 准备环境

需要 Node.js **22.12 或以上版本**、**pnpm 10.12.1**（见 `packageManager`）、Git 和可连接的 PostgreSQL 数据库。数据库需提前创建；仓库没有自带数据库服务。后台导入 GitHub 技能时，API 进程需要能够执行 `git` 并访问 GitHub。

```sh
git clone https://github.com/DarkNoah/aime-hub.git
cd aime-hub
pnpm install --frozen-lockfile
cp .env.example .env
openssl rand -base64 32
```

将生成的随机值填入 `.env` 的 `BETTER_AUTH_SECRET`，并配置数据库连接：

```dotenv
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/aime_hub
BETTER_AUTH_SECRET=<至少32字符的随机密钥>
BETTER_AUTH_URL=http://127.0.0.1:5173
WEB_ORIGIN=http://127.0.0.1:5173
SERVER_PORT=3001
ADMINS=admin
WORKSPACE_ROOT=workspaces
```

使用独立的应用数据库。`.env` 和默认的 `workspaces/` 已被 Git 忽略；若将工作目录改到仓库内的其他位置，也需将该目录加入忽略规则。

### 2. 初始化数据库与管理员

在仓库根目录运行：

```sh
pnpm db:migrate
pnpm auth:create-admin
```

迁移命令先初始化 Better Auth 认证表，再应用 TypeORM 业务迁移；可重复执行，不会清空已有数据。Mastra 在 API 启动时初始化独立的 `mastra` schema，因此数据库用户还需要相应建表及 schema 权限。

管理员初始化会交互询问用户名、邮箱和密码。用户名必须在 `ADMINS` 中；**项目没有默认账号或默认密码**。公开注册不会授予管理员角色，修改 `ADMINS` 也不会改变已有用户的角色。需要多个管理员时，配置多个保留用户名后重复运行初始化命令。

### 3. 启动应用

```sh
pnpm dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。API 默认监听 `127.0.0.1:3001`，Vite 将 `/api` 请求代理至后端。

浏览器地址、`BETTER_AUTH_URL` 和 `WEB_ORIGIN` 必须一致，包括协议、主机名及端口；不要混用 `localhost` 和 `127.0.0.1`。修改 `.env` 后需要重启开发服务。

后端默认通过 Undici hook 输出模型接口（`/chat/completions`、`/responses`）实际发送的完整请求 body，日志以 `[chat:request]` 开头，包含请求 ID 和接口地址。每次重试、工具调用后的续问，以及标题生成等辅助模型请求都会单独记录；body 发送中断时标记为 `incomplete`。日志保留正文中的完整对话、附件及工具参数，地址中的查询参数和请求头不输出。

管理员可在 **管理后台 → 请求日志**（`/admin/request-logs`）查看这些请求。新日志异步保存到 PostgreSQL 的 `chat_request_logs` 表，重启后保留；部署更新时先运行 `pnpm db:migrate`。页面支持按模型、接口、请求 ID 搜索，按请求体发送状态筛选，分页查看，以及自动刷新最新一页。详情按需加载完整原文，提供 JSON 格式化和原文复制；浏览历史页或详情时自动刷新暂停。状态仅表示请求体是否完整发送，不代表模型响应成功。历史控制台输出不会补录。

### 4. 配置模型并开始对话

1. 使用管理员账号登录，进入 **模型供应商**（`/admin/providers`）。
2. 创建语言模型供应商，填写 Base URL 与 API Key。Base URL 使用 API 根地址，包含服务要求的 `/v1` 等路径。
3. 拉取模型列表或手动添加模型，核对图片输入、推理、工具调用及上下文长度等能力，并启用要使用的模型。
4. 选择系统默认模型与思考等级，进入 **个人聊天**（`/threads`）发送消息；也可在 **项目**（`/projects`）中创建共享工作空间。

聊天连接读取后台保存的供应商配置。`.env.example` 中预留的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `DEFAULT_MODEL` 不会自动配置聊天模型。

## 使用说明

### 模型与默认配置

模型引用使用 `<providerId>/<完整模型ID>`，支持模型 ID 自身包含 `/`。个人对话按当前请求选择、个人默认、系统默认依次解析；项目对话使用项目默认配置，不继承个人配置。聊天内的个人模型与思考设置自动保存。

模型同步通过供应商的 `/models` 接口拉取列表，并尝试使用 models.dev 补齐能力。已有模型的手工字段会保留；远端消失的模型标记为过时，不会自动删除。被默认配置引用的模型需先取消引用，才能删除、停用或修改 ID。配置模型和同步列表不会自动执行模型推理。

API Key 只在服务端使用，HTTP 响应不返回密钥；编辑时留空保留原值，显式清除才删除。当前密钥在数据库中明文存储，应妥善保护数据库及备份。模型列表同步仅允许公共网络 HTTP(S) 地址，携带密钥时要求 HTTPS，不支持私网/回环地址同步。

### 网页搜索、读取与工具配置

聊天提供 `web_search` 工具，通过 Mastra 的 `createTool` 和 `provider.webSearch()` 执行搜索。未选择供应商时默认使用搜狗；选择供应商后优先调用该供应商，请求失败或供应商不可用时使用搜狗兜底。成功但没有结果的搜索保留空结果，用户取消后不会继续兜底。返回值包含标题、链接、摘要及实际搜索供应商。

1. 在 **模型供应商 → 新建供应商 → 其他组 → serpapi** 中配置名称、API Key 和 API 根地址（默认 `https://serpapi.com`）。SerpAPI 用于搜索，不参与聊天模型同步或默认模型选择。
2. 在 **工具配置**（`/admin/tools`）编辑网页搜索，选择上述供应商，设置启停、最多结果数（1–20）和每个供应商的超时（1–60 秒）。API Key 仅保存在供应商配置中，不由工具配置重复保存或返回。
3. 配置保存在已有 `settings` 表的 `tool:web_search` 记录中，无需新增迁移。聊天通过 Mastra 动态工具配置读取最新值，再调用 `createTool`；进行中的搜索保留启动时的参数。后续工具可通过共享配置 schema 和服务端工厂注册扩展。

`web_fetch` 使用项目自定义工具。在 **模型供应商 → 其他组 → jina-ai** 中配置 Jina AI，Reader 根地址默认为 `https://r.jina.ai`，然后在 **工具配置 → 网页读取** 中选择该供应商。可设置启停、每阶段超时和最大返回字符数，配置保存在 `tool:web_fetch`。

读取顺序为 **Jina AI → 直接请求 + Defuddle → 独立浏览器 + Defuddle**，通过 `defuddle/node` 提取正文并直接输出 Markdown。关闭 Defuddle 自带的异步外部抓取，统一使用项目的网络请求和取消控制。未选择供应商时从直接请求开始；供应商被停用、删除或请求失败时自动兜底。取消后不会进入下一阶段，长正文会截断并标记 `truncated`。本地读取仅访问公网 HTTP(S) 地址，重定向及浏览器资源同样校验地址。

浏览器兜底使用 `playwright-core`，部署环境需要预先执行 `pnpm --filter @aime/server exec playwright-core install chromium` 安装对应版本的 Chromium。

搜狗兜底抓取公开搜索页面并解析结果和跳转链接，不执行返回的脚本，也不抓取结果目标页。验证码或页面结构变化可能导致兜底失败，此时工具返回可识别的错误，不会伪造结果。

### 会话、队列与后台任务

每个线程由 Mastra 原生消息队列调度：普通消息使用 `queueMessage()`，即时输入使用 `sendMessage()`。空闲时直接运行，忙碌时普通消息按 FIFO 等待；界面显示官方队列数量，并通过官方取消／重新入队接口提供编辑、排序、即时切换和清空。已进入执行的消息不能再编辑；重新提交失败时保留草稿供手动重试。

- 每条消息最多附带 4 张图片，每张不超过 2 MiB；模型需支持图片输入。
- 停止当前轮会保留已生成的部分回复，同时清空待处理消息。
- 工具请求审批或补充输入时，可在消息卡片中回应后恢复执行。
- 标题旁的后台任务入口显示任务列表，可单独取消任务。停止当前 Agent 轮次不会自动取消独立后台任务。
- 全局导航通过独立 SSE 同步会话摘要与项目运行数量，未打开的会话也会更新状态。

线程、已消费的消息和任务记录会持久化。原生待处理队列由当前服务进程持有，重启后不会恢复；未完成的会话会提示中断，已保存的消息仍可查看或重试。详细协议见 [个人聊天](docs/personal-chat.md)。

### 项目协作

项目创建者成为 owner；owner/admin 管理项目配置及成员，member 参与共享对话。项目内所有会话使用同一个项目工作目录。服务端按项目成员身份校验会话、事件与文件访问。

删除会话会保留其工作文件；删除项目也保留聊天和文件，但撤销项目访问。存在运行任务、排队消息或活动后台任务时会限制删除。角色和接口边界见 [项目模块](docs/projects.md)。

### 工作区文件与 Skills

`WORKSPACE_ROOT` 的相对路径从运行命令的仓库目录解析，默认布局如下：

```text
workspaces/
├── .agents/skills/                       # 全局技能
├── users/<userId>/
│   ├── .agents/skills/                   # 个人技能，覆盖全局同名技能
│   └── <yyyy-MM-dd>-<随机ID>/            # 每个个人会话的工作目录
└── projects/<projectId>/
    └── .agents/skills/                   # 项目技能，覆盖全局同名技能
```

项目会话的工作目录就是 `projects/<projectId>/`。技能目录应包含 `SKILL.md`，可与脚本、参考资料一起存放；支持嵌套目录分组，技能 ID 和 `/` 命令名取技能包目录名。扫描遇到 `SKILL.md` 后即将该目录视为技能包，不再继续扫描包内子目录。全局技能目录位于 **`WORKSPACE_ROOT/.agents/skills`**。

在输入框键入 `/` 可按名称、描述与目录分组查找技能，通过方向键、Enter、Tab 或点击补全。目录中的有效技能与 Agent 运行时共用读取规则，技能原文件不会因名称规范化被改写。

会话右侧面板可切换 **文件** 和 **原始消息**，窄屏使用抽屉。文件支持多标签预览及下载；文本预览上限为 512 KiB，超出部分可下载查看，未知二进制文件提供下载。文件操作受当前会话的工作目录及权限约束，不提供任意服务器路径访问。

### 后台 Skills 管理

管理员在 `/admin/skills` 查看、搜索及删除全局技能，通过“从 GitHub 导入”扫描仓库并按文件夹批量勾选安装。支持以下来源：

已安装技能的分组支持展开、收起和整组删除。删除确认会列出该组全部技能，包括搜索暂时隐藏的条目；分组内容变化时需刷新后重新确认。删除仅作用于确认清单中的技能包，独立子分组及目录中的其他文件会保留，空分组目录会自动清理。

| 输入                                                       | 扫描范围                       |
| ---------------------------------------------------------- | ------------------------------ |
| `owner/repo` 或 `https://github.com/owner/repo`            | 默认分支的整个仓库             |
| `https://github.com/owner/repo/tree/<ref>/<目录>`          | 指定分支或版本下的目录及子目录 |
| `https://github.com/owner/repo/blob/<ref>/<目录>/SKILL.md` | 指定技能及其同目录资源         |

导入功能需要 API 服务器安装 Git 并能访问公开 GitHub 仓库。扫描固定仓库提交，安装从该次扫描的快照读取，目标目录为：

```text
<WORKSPACE_ROOT>/.agents/skills/<owner>/<repo>/<skill-name>/SKILL.md
```

安装会保留技能目录内的脚本和参考文件，跳过符号链接与子模块，并校验技能格式和路径。已有目标目录不会被静默覆盖；批量安装发生错误时回滚本批次写入。扫描结果保留 15 分钟，过期后需重新扫描。安装后的全局技能可被个人与项目聊天发现。

### 后台环境变量管理

管理员在 `/admin/environment-variables` 新增、搜索、编辑和删除环境变量。页面使用 AI Elements Environment Variables 组件，默认遮罩变量值，支持显隐切换、复制、空值及多行值。名称区分大小写，必须以字母或下划线开头，仅允许字母、数字和下划线；重复名称返回 `409`。

配置保存在独立的 `environment_variables` 表中；新增迁移后需运行 `pnpm db:migrate`。当前阶段仅提供配置 CRUD，不修改 `.env` 或 `process.env`，也不自动注入 Agent/工具运行环境。

接口仅允许管理员访问，通过共享 oRPC 契约提供 `environmentVariables.list/get/create/update/remove`，同时支持 HTTP：

| 方法     | 路径                                   | 用途                                 |
| -------- | -------------------------------------- | ------------------------------------ |
| `GET`    | `/api/admin/environment-variables`     | 列表                                 |
| `POST`   | `/api/admin/environment-variables`     | 新增 `{ name, value, description? }` |
| `GET`    | `/api/admin/environment-variables/:id` | 单条详情                             |
| `PATCH`  | `/api/admin/environment-variables/:id` | 更新名称、值或说明                   |
| `DELETE` | `/api/admin/environment-variables/:id` | 删除                                 |

写请求校验同源 `Origin`，所有响应禁止缓存；变量值仅在此管理员接口中显式读取。

### 用户管理与语言

管理员在 `/admin/users` 创建或编辑用户、调整角色、重置密码、封禁及撤销会话。重置密码不会自动撤销已有会话；需要强制退出时，另行执行撤销会话。删除用户为不可恢复的硬删除，临时停用可使用封禁。

页面根据浏览器语言选择简体中文或英文，未匹配时回退英文，当前没有账号级语言选项。翻译资源位于 `apps/web/src/i18n/locales/`，新增文案需同步两种语言。

## 环境变量

| 变量                 | 说明                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`       | PostgreSQL 连接串，必填                                               |
| `BETTER_AUTH_SECRET` | 至少 32 字符的认证密钥，必填；更换会使已有会话失效                    |
| `BETTER_AUTH_URL`    | 用户实际访问的应用地址，必填                                          |
| `WEB_ORIGIN`         | 允许的浏览器来源，必填；与应用地址一致                                |
| `SERVER_PORT`        | API 端口，默认 `3001`                                                 |
| `ADMINS`             | 逗号分隔的保留管理员用户名，默认 `admin`                              |
| `WORKSPACE_ROOT`     | 会话文件及技能的根目录，默认 `workspaces`                             |
| `NODE_ENV`           | 默认 `development`；生产设为 `production`，认证地址与来源需使用 HTTPS |
| `TEST_DATABASE_URL`  | 测试专用 PostgreSQL 连接串；未设置时跳过数据库集成测试                |

## 开发与验证

| 命令                     | 用途                                      |
| ------------------------ | ----------------------------------------- |
| `pnpm dev`               | 同时启动 API 和前端开发服务               |
| `pnpm db:migrate`        | 初始化认证表并执行业务迁移                |
| `pnpm auth:create-admin` | 交互创建管理员                            |
| `pnpm typecheck`         | 工作区包与测试脚本的类型检查              |
| `pnpm lint`              | ESLint 检查                               |
| `pnpm format:check`      | Prettier 格式检查                         |
| `pnpm format`            | 格式化源码                                |
| `pnpm test`              | 运行单元、HTTP/SSE 和可用的数据库集成测试 |
| `pnpm build`             | 构建 API 与前端                           |
| `pnpm start`             | 启动编译后的 API；前端静态文件需另行托管  |
| `pnpm providers:catalog` | 更新供应商能力目录                        |

VS Code 已提供 **Aime Hub：全栈调试** 启动配置，可在完成环境配置后按 F5 使用。

提交前建议运行：

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

数据库集成测试需要显式设置连接串：

```sh
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/aime_hub_test pnpm test
```

测试在指定数据库创建随机 schema，结束时只清理对应 schema；测试账号需要创建 schema 的权限。建议使用专用测试数据库。测试覆盖认证与权限、供应商配置、项目成员、线程队列与恢复、工具交互、后台任务、技能发现、文件边界及国际化等。

自动化测试中的确定性执行器和本机模型模拟服务不代表真实供应商验收。真实模型的图片理解、思考参数、长上下文与 Observational Memory 行为需要配置相应供应商后单独验证。测试通过数量以当次输出为准。

## 目录结构

```text
apps/
├── web/src/
│   ├── router.tsx           # TanStack Router 类型化路由树与懒加载
│   ├── lib/rpc.ts           # 共享 oRPC 客户端
│   ├── pages/               # 认证、工作台、聊天、项目及后台页面
│   ├── components/          # chat、file-manager、model-selector、UI 等复用组件
│   ├── features/            # 认证会话、模型目录等共享逻辑
│   ├── layouts/             # 应用布局与导航
│   └── i18n/                # 语言配置与翻译资源
└── server/src/
    ├── modules/             # auth、providers、models、projects、threads、files、skills 等
    ├── rpc/                 # 会话、管理员权限、来源与错误映射
    ├── mastra/              # Mastra 实例、存储和工具
    └── middleware/          # HTTP 错误处理
packages/
├── auth/                    # Better Auth 配置、插件与认证迁移
├── db/                      # TypeORM 业务实体、数据源与显式迁移
└── shared/                  # 共享类型、oRPC 契约、校验规则与环境加载
scripts/                     # 初始化、迁移、目录更新及测试
docs/                        # 设计与模块文档
```

前后端按业务模块组织，页面专属组件就近存放，跨页面交互放在 `components/`。认证表由 Better Auth 管理，业务表由 TypeORM 管理，线程和消息由 Mastra 管理。TypeORM `synchronize` 关闭，API 启动时检查待执行迁移，不会自动修改认证或业务表结构。

## 路由与 API 架构

页面使用 `apps/web/src/router.tsx` 中的 TanStack Router 路由树。页面仍按业务存放于 `pages/`，通过懒加载拆分；动态链接使用 `$projectId` / `$threadId` 和类型化 `params`，登录、会话和管理员布局共用原有会话状态。

业务请求的唯一契约位于 `packages/shared/src/rpc/`，输入复用 Zod 校验，输出声明共享 DTO。后端在 `apps/server/src/modules/<业务>/rpc.ts` 实现，统一由 Hono 挂载：

- `/api/rpc/*`：前端通过 `apps/web/src/lib/rpc.ts` 的 `api` 调用，输入输出从契约推导；浏览器不导入后端实现或数据库代码。
- 原有 `/api/threads`、`/api/projects`、`/api/admin/providers` 等 HTTP 地址：同一套过程通过 oRPC OpenAPIHandler 提供兼容入口，不重复实现业务逻辑。
- `/api/auth/*`：Better Auth 原生 Web Request handler，用户管理继续由其 admin 插件负责。
- `/api/threads/events`、`/api/threads/:threadId/messages`：Hono SSE，保留独立订阅、心跳、权限复查和断开清理。取消订阅不会停止服务端执行。
- `/api/threads/:threadId/files/raw`：Hono 文件响应，保留权限检查、Range / HEAD、下载与内容安全响应头。

新增业务接口先增加共享契约，再实现对应模块过程，最后通过类型化客户端调用。会话和管理员检查在 oRPC 中间件中执行，非安全 HTTP 方法（包括 RPC POST）要求匹配 `WEB_ORIGIN`；HTTP 和 RPC 共用业务权限检查及稳定错误码。API 时间字段显式转换为 ISO 字符串，避免 RPC 的 Date 支持改变既有 DTO。

本次迁移不改变数据库结构；开发、构建、启动命令和同域 `/api/*` 代理规则保持不变。框架参考：[TanStack Router](https://tanstack.com/router/latest/docs/quick-start)、[Hono Node.js](https://hono.dev/docs/getting-started/nodejs)、[oRPC Contract First](https://v1.orpc.dev/docs/contract-first/implement-contract)。

## 部署

当前部署方式为 **单个 API 实例 + PostgreSQL + 持久工作目录 + 同域前端静态服务**。执行队列、事件广播和部分限流状态由单进程持有，多实例部署前需要共享执行锁、事件通道及限流存储。

1. 配置生产环境变量，设置 `NODE_ENV=production`，使用 HTTPS 的 `BETTER_AUTH_URL` 和 `WEB_ORIGIN`。
2. 在仓库根目录执行 `pnpm install --frozen-lockfile`、`pnpm db:migrate`、`pnpm build`。
3. 使用进程管理器运行 `pnpm start`。API 仅监听 `127.0.0.1`，反向代理需能访问该回环地址。
4. 托管 `apps/web/dist`，为 SPA 路由提供 `index.html` 回退，将同域 `/api/*` 转发至 API。
5. 为 SSE 关闭代理缓冲、配置长连接超时；持久化并备份 PostgreSQL 和 `WORKSPACE_ROOT`。

应用默认不信任转发头，代理部署的登录限流可能按代理地址共享额度。公网部署应根据实际拓扑配置可信代理与真实客户端 IP。当前未实现邮件验证、找回密码或邮件发送；注册邮箱仅用作账号标识。

## 常见问题

- **登录或退出报 `Invalid origin`**：对照浏览器地址检查 `BETTER_AUTH_URL`、`WEB_ORIGIN`，修正后重启服务。
- **提示 `环境配置无效`**：检查错误列出的变量；`BETTER_AUTH_SECRET` 不能为空且至少 32 字符。
- **数据库连接报 `ECONNREFUSED`**：确认 PostgreSQL 已启动，连接串的地址、端口、库名及凭据正确。
- **前端可打开但 `/api/health` 失败**：查看 API 日志，检查数据库连接及迁移是否完成。
- **无法聊天或提示未配置模型**：在供应商管理中配置并启用可输出文本的语言模型，设置系统或个人/项目默认模型。
- **找不到刚加入的技能**：检查实际 `WORKSPACE_ROOT`、`SKILL.md` 格式、技能包目录名和作用域；项目会话不会加载个人技能。
- **开发端口被占用**：Vite 使用固定端口，不会自动切换。调整前端端口时同步修改认证地址与来源，可用 `pnpm --filter @aime/web dev --port <端口>` 单独启动前端。

## 相关文档

- [产品需求](docs/PRD.md)
- [模块组织与架构](docs/architecture.md)
- [Agent 执行规范](docs/harness.md)
- [个人聊天与运行协议](docs/personal-chat.md)
- [项目协作与权限](docs/projects.md)
- [模型供应商模块](docs/模型供应商模块.md)
- [开发约定](AGENTS.md)
