# Aime Hub

基于 React、TanStack Router、Hono、oRPC 和 Mastra 的 AI 工作空间，支持个人对话、项目协作、模型供应商管理与会话工作目录。消息由服务端持续执行，通过 SSE 同步；关闭页面不会中断正在进行的对话。

## 功能

| 模块       | 当前能力                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| 账号与权限 | 用户名登录、注册、持久会话；管理员管理用户、角色、密码、封禁与会话撤销                                 |
| 模型管理   | 供应商与模型管理、OpenAI 兼容模型列表同步、能力配置、系统默认模型与思考等级                            |
| 个人聊天   | 流式回复、Markdown、推理过程、图片输入、工具结果、上下文用量、错误重试与历史分页                       |
| 消息队列   | Mastra 原生 FIFO 队列，通过取消重入队支持编辑、排序，支持清空与停止                                    |
| 工具交互   | 工具审批、用户问题与挂起恢复；后台任务状态、结果展示和单独取消                                         |
| 项目协作   | owner/admin/member 角色、成员管理、共享对话、项目默认模型与共享工作目录                                |
| 自动化     | 个人、项目、系统任务；系统时区调度、独立线程显示开关、启停、立即运行、最近 30 次运行结果，共用管理界面 |
| 工作区文件 | 文件树、文件名与内容搜索、新建、重命名、删除、下载，文本/代码及图片、音频、视频预览                    |
| Skills     | 后台扫描 GitHub 并批量安装技能，支持全局及个人/项目覆盖，输入 `/` 搜索并补全技能命令                   |
| 界面       | 中英文随浏览器语言切换、响应式导航、可调整宽度的文件/消息检查面板、全局会话运行状态                    |

### MCP 管理

管理员在 `/admin/mcp` 管理多个 MCP 连接，支持表单与 `{"mcpServers":{"name":{...}}}` JSON 切换及批量创建。Stdio 使用 `command`、`args`、`env`；Streamable HTTP / SSE 使用 `url`、`headers`。参数一行一项并忽略空白行，环境变量和请求头使用 `Key=Value`，保留值中的等号。

配置通过 Mastra 原生 `MCPClientsStorage` 写入 `mastra_mcp_clients.metadata`，每个服务一条记录，带 `managedBy: admin-mcp` 标识，不保存额外的连接类型。原生版本表只保留 SDK 要求的空配置快照；连接配置以 metadata 为准，通过适配器传给 `@mastra/mcp` 的 `MCPClient`。没有新增业务表。

新配置默认 `draft`。发布前必须通过 SDK `listToolsWithErrors()` 的连接与工具发现检查（有效的空工具列表也表示连接成功），成功后才写入原生 `published` 状态及 `activeVersionId`。编辑已发布配置会先检查新连接，失败时保留旧配置和旧连接。取消发布、删除与进程退出会释放客户端；旧工具引用在执行前也重新检查发布状态和配置版本。

客户端在 API 进程内常驻，启动时连接已发布配置，所有聊天 Agent 和自动化任务共用同一工具构建入口与连接。线程创建只读取已连接的工具，不重复启动子进程。启动时不可用的连接不会阻止服务启动，可在后台“测试连接”重连；MCP 工具沿用聊天的通用工具结果展示。SDK 使用兼容当前 Mastra Core 的 1.x，以同时支持 Streamable HTTP 和旧版 SSE。

已发布服务的“工具列表”侧栏通过常驻客户端的原生 `listToolDefinitionsWithErrors` 读取服务工具，支持按名称或说明搜索、刷新和展开输入／返回结果 JSON Schema。查看列表不会新建 MCPClient；尚未建立连接时需先测试连接。

### 自动化任务

个人入口在左侧栏 `/automations`，项目入口在项目仪表盘 `/projects/:projectId/automations`，系统入口在管理后台 `/admin/automations`。个人任务仅本人可访问；项目成员可查看，owner/admin 可管理；系统任务仅系统管理员可访问。每次执行前重新检查创建者的账号、项目权限或管理员身份，权限失效后不会继续调用模型。

调度使用 [Mastra Agent Schedule](https://mastra.ai/reference/schedules/overview#agent-schedule-input)。保存时仅预留 `schedule:<16 位随机 ID>` 并将 `threadId`、`resourceId` 写入调度配置，首次定时触发或手动运行时才创建线程与工作目录；后续触发在同一线程中继续，保留对话上下文。开启“独立线程”后，已开始执行的任务线程显示在聊天列表中，并带有时钟图标；关闭只隐藏入口，不删除线程或历史。个人线程归属本人、项目线程归属项目、系统线程仅管理员可见。项目任务使用项目共享工作空间，个人与系统任务各有独立任务目录，系统任务不继承创建者的个人模型设置。已有线程继续保留并复用。

任务始终使用后端服务器系统时区（可通过服务进程的 `TZ` 设置），表单不接受自定义时区；重启时同步已有任务的时区。服务启动时将旧 workflow schedule 原地升级为 Agent Schedule，保留原任务 ID、触发记录与旧工作流结果。新任务配置、触发记录分别存于 `mastra_schedules`、`mastra_schedule_triggers`，对话存于 `mastra_threads` / `mastra_messages`，每次运行状态及结果存于 `mastra_thread_state` 的 `automation-run:<runId>` 命名空间。

服务器需要保持在线。支持暂停后手动运行；立即运行不改变原定频率。任务线程正在运行时跳过新的触发，单次执行限时 10 分钟、最多 100 个 Agent 步骤。暂停或删除任务不取消已经开始的运行，删除任务保留线程及消息；归档或删除线程后，任务不会另建线程继续执行。服务关闭时中止运行，重启不会自动重放可能已经产生外部副作用的未完成任务。最近 30 次运行记录按系统时区显示。

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
WEB_ORIGINS=
WEB_HOST=0.0.0.0
SERVER_HOST=0.0.0.0
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

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。开发时只需访问或转发 Vite 的一个端口，端口由 `WEB_ORIGIN` 决定（示例为 `5173`）；页面、认证、RPC、SSE 和文件请求都走同一个入口。前后端默认均监听 `0.0.0.0`，Vite 将 `/api` 代理至本机 `127.0.0.1:3001`。开发环境仍运行前后端两个进程，浏览器无需单独访问后端端口。

`BETTER_AUTH_URL` 是认证使用的主地址，`WEB_ORIGIN` 是默认浏览器入口（也决定 Vite 端口和 VS Code 打开地址）。浏览器来源必须匹配 `WEB_ORIGIN` 或 `WEB_ORIGINS` 中明确列出的地址，包括协议、主机名及端口。修改 `.env` 后需要重启开发服务。

同时支持本机和局域网访问时，保留主地址，并设置逗号分隔的来源白名单：

```dotenv
BETTER_AUTH_URL=http://127.0.0.1:5173
WEB_ORIGIN=http://127.0.0.1:5173
WEB_ORIGINS=http://127.0.0.1:5173,http://192.168.1.13:5173
```

`WEB_ORIGIN` 会自动加入白名单，`WEB_ORIGINS` 也可以只填写额外的局域网地址；需要 `localhost` 时应显式加入。认证与业务 API 共用这份白名单，不支持通配符。不同主机分别保存登录 Cookie，因此通常需要分别登录；账号和业务数据共用。`WEB_HOST` 和 `SERVER_HOST` 默认均为 `0.0.0.0`，这是监听地址，浏览器需使用实际 IP 或主机名访问。终端的 `Web entry:` 显示默认入口。

后端默认通过 Undici hook 输出模型接口（`/chat/completions`、`/responses`）实际发送的完整请求 body，日志以 `[chat:request]` 开头，包含请求 ID 和接口地址。每次重试、工具调用后的续问，以及标题生成等辅助模型请求都会单独记录；body 发送中断时标记为 `incomplete`。日志保留正文中的完整对话、附件及工具参数，地址中的查询参数和请求头不输出。

管理员可在 **管理后台 → 请求日志**（`/admin/request-logs`）查看这些请求。新日志异步保存到 PostgreSQL 的 `chat_request_logs` 表，重启后保留；部署更新时先运行 `pnpm db:migrate`。捕获器从实际请求的 `X-THREAD-ID`、`X-RESOURCE-ID`、`X-USER-ID`、`X-PROJECT-ID` Header 提取标识，分别存入带索引的 `thread_id`、`resource_id`、`user_id`、`project_id` 字段；缺失 Header 和旧日志对应字段为 `NULL`，不会补录。页面支持按模型、接口、请求 ID 及上述标识搜索，也支持四个标识的组合精确筛选、请求体发送状态筛选、分页和自动刷新。详情展示关联标识，按需加载完整原文，提供 JSON 格式化和原文复制；浏览历史页或详情时自动刷新暂停。状态仅表示请求体是否完整发送，不代表模型响应成功。历史控制台输出不会补录。

请求发送后立即入库，响应完成或中断后更新同一条记录的 `duration_ms`、`http_status`、`response_status`、响应类型、编码、接收字节数及响应内容。耗时从 Undici 创建请求开始计时，包含连接、发送及完整流式接收过程；每次 HTTP 重试单独计时。响应通过传输层分块捕获，JSON 与 SSE 保留原始文本，gzip / deflate / brotli 自动解压；无法还原为 UTF-8 文本的内容保存原始接收字节的 Base64。`response_bytes` 统计解压前的接收字节数，请求发送状态与响应接收状态分别展示，HTTP 错误响应也会保留。列表不加载请求或响应正文，详情提供请求 / 响应切换和复制；等待响应完成时详情自动更新。旧日志的响应与耗时字段为 `NULL`。

### 4. 配置模型并开始对话

1. 使用管理员账号登录，进入 **模型供应商**（`/admin/providers`）。
2. 创建语言模型供应商，填写 Base URL 与 API Key。Base URL 使用 API 根地址，包含服务要求的 `/v1` 等路径。
3. 拉取模型列表或手动添加模型，核对图片输入、推理、工具调用及上下文长度等能力，并启用要使用的模型。
4. 选择系统默认模型与思考等级，进入 **个人聊天**（`/threads`）发送消息；也可在 **项目**（`/projects`）中创建共享工作空间。

聊天连接读取后台保存的供应商配置。`.env.example` 中预留的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `DEFAULT_MODEL` 不会自动配置聊天模型。

## 使用说明

生产环境使用 Dockerfile + Docker Compose，支持 Dokploy 从 Git 自动部署。容器运行环境、HTTPS、持久化和管理员初始化见 [部署说明](docs/deployment.md)。

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

### 后台 Agent 管理与聊天选择

管理员在 **管理后台 → Agent 管理**（`/admin/agents`）创建、编辑和删除自定义 Agent，配置系统提示词、模型、应用工具与后台已安装的 Skills。代码 Agent 定义在 `apps/server/src/mastra/agents/`，在 `index.ts` 注册；示例 `code:assistant` 是通用助手。代码配置直接从注册表读取，不写入 Agent 数据表，管理页仅提供只读详情，服务端也拒绝修改和删除。按 ID 查找时优先匹配代码注册表，未命中才读取数据库；已有同 ID 数据只展示和使用代码配置。自定义 Agent 的 ID 由服务端生成并避开代码已占用的 ID，创建接口不接受客户端指定 ID。

自定义 Agent 使用 Mastra 原生 `agents` storage domain，记录与版本分别保存在 `mastra.mastra_agents` 和 `mastra.mastra_agent_versions`；每次保存创建新版本，无需新增数据表。自定义 Agent 创建时为草稿，管理页通过发布开关切换 `draft` / `published`；只有 `published` 状态可进入可用列表、设置为默认项或构建运行实例，草稿和归档项均不可使用。编辑已发布项会保持发布状态并更新激活版本，运行中的会话仍保留原配置。修改、删除和状态切换携带版本 ID，单服务进程内串行检查以拒绝过期编辑；默认项需先更换后才能删除或取消发布。

后台默认 Agent 写入 `settings` 的 `agents:defaults`，值为 `{ defaultAgentId }`；没有设置或默认项被外部删除、取消发布时回退到代码通用助手。`GET /api/rpc/agents/available`（HTTP 形式 `/api/agents/available`）向已登录用户返回 `{ defaultAgentId, agents }`，仅含可选项的 ID、名称、说明、模型和来源。配置管理与默认项写入要求管理员权限，写操作校验 Origin。

聊天输入框上方可选择 Agent，选择保存到现有个人配置 `settings[chat:user:<userId>].agentId`，刷新或开启下一次聊天时恢复。选择“跟随系统默认”保存 `null`；未指定 Agent 时，配置入口 `AgentService.getConfig(id)` 解析默认项。项目聊天也保留个人 Agent 选择，不修改项目共享模型配置。固定模型优先于聊天模型；模型留空则沿用聊天模型和现有模型默认解析规则。API 空模型为 `null`，原生版本仍以 `model: []` 表示未固定模型，运行前才解析实际模型。

运行时调用 `AgentService.getAgent(id, { model, tools, memory, workspace, goal, instructions, ... })` 获取构建后的 Mastra `Agent`；`model` 等依赖由当前会话提供，`instructions` 可覆盖默认提示词，工具从传入集合中按配置筛选，`versionId` 可固定已解析的数据库版本。每个聊天原生会话使用独立实例，加载对应提示词、遵守全局启停状态的应用工具，以及所选 `.agents/skills` 目录技能。Skills 以原生 `workspace` provider 引用 `{ type: 'provider', provider: 'installed-skills', config: { skillPaths } }` 纳入版本，运行时按已发现的安装目录解析。工作区和浏览器工具继续由聊天运行时提供。排队消息、工具恢复和正在运行的任务使用已固定的配置；在运行、排队、后台任务、工具等待或活跃目标结束后，可切换 Agent 或加载更新后的配置版本。

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

| 变量                 | 说明                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`       | PostgreSQL 连接串，必填                                                |
| `BETTER_AUTH_SECRET` | 至少 32 字符的认证密钥，必填；更换会使已有会话失效                     |
| `BETTER_AUTH_URL`    | 认证主地址，必填；保留一个完整 URL                                     |
| `WEB_ORIGIN`         | 默认浏览器入口，必填；决定 Vite 端口和 VS Code 打开地址                |
| `WEB_ORIGINS`        | 可选的额外来源白名单，逗号分隔；认证与 API 共用，自动包含 `WEB_ORIGIN` |
| `WEB_HOST`           | Vite 开发监听地址，默认 `0.0.0.0`                                      |
| `SERVER_HOST`        | API 监听地址，默认 `0.0.0.0`                                           |
| `SERVER_PORT`        | 内部 API 端口，默认 `3001`；Vite 的 `/api` 代理读取同一配置            |
| `ADMINS`             | 逗号分隔的保留管理员用户名，默认 `admin`                               |
| `WORKSPACE_ROOT`     | 会话文件及技能的根目录，默认 `workspaces`                              |
| `NODE_ENV`           | 默认 `development`；生产设为 `production`，认证地址与来源需使用 HTTPS  |
| `TEST_DATABASE_URL`  | 测试专用 PostgreSQL 连接串；未设置时跳过数据库集成测试                 |

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

VS Code 已提供 **Aime Hub：全栈调试** 启动配置，可在完成环境配置后按 F5 使用。调试器先启动 API，待后端就绪后启动 Vite，再自动打开 `WEB_ORIGIN` 对应的 Chrome 调试窗口；前后端均监听 `0.0.0.0` 并支持断点。停止主调试会话会一并停止 Vite 和浏览器调试。启动前请先停止占用相同端口的 `pnpm dev`，端口被占用时 Vite 会报错，不会自动改用另一个端口。

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

新增业务接口先增加共享契约，再实现对应模块过程，最后通过类型化客户端调用。会话和管理员检查在 oRPC 中间件中执行，非安全 HTTP 方法（包括 RPC POST）要求匹配 `WEB_ORIGIN` / `WEB_ORIGINS` 的来源白名单；HTTP 和 RPC 共用业务权限检查及稳定错误码。API 时间字段显式转换为 ISO 字符串，避免 RPC 的 Date 支持改变既有 DTO。

本次迁移不改变数据库结构；开发、构建、启动命令和同域 `/api/*` 代理规则保持不变。框架参考：[TanStack Router](https://tanstack.com/router/latest/docs/quick-start)、[Hono Node.js](https://hono.dev/docs/getting-started/nodejs)、[oRPC Contract First](https://v1.orpc.dev/docs/contract-first/implement-contract)。

## 部署

当前部署方式为 **单个 API 实例 + PostgreSQL + 持久工作目录 + 同域前端静态服务**。执行队列、事件广播和部分限流状态由单进程持有，多实例部署前需要共享执行锁、事件通道及限流存储。

1. 配置生产环境变量，设置 `NODE_ENV=production`，`BETTER_AUTH_URL`、`WEB_ORIGIN` 和 `WEB_ORIGINS` 中的所有来源均须使用 HTTPS。
2. 在仓库根目录执行 `pnpm install --frozen-lockfile`、`pnpm db:migrate`、`pnpm build`。
3. 使用进程管理器运行 `pnpm start`。API 仅监听 `127.0.0.1`，反向代理需能访问该回环地址。
4. 托管 `apps/web/dist`，为 SPA 路由提供 `index.html` 回退，将同域 `/api/*` 转发至 API。
5. 为 SSE 关闭代理缓冲、配置长连接超时；持久化并备份 PostgreSQL 和 `WORKSPACE_ROOT`。

应用默认不信任转发头，代理部署的登录限流可能按代理地址共享额度。公网部署应根据实际拓扑配置可信代理与真实客户端 IP。当前未实现邮件验证、找回密码或邮件发送；注册邮箱仅用作账号标识。

## 自动化通知

任务完成或失败后，登录用户会收到右上角的 shadcn Base UI Toast，独立于任务的「桌面通知」开关。开启开关后使用 Web Push + Service Worker，即使关闭网页也可收到通知。个人任务发给创建者，项目任务发给当前项目成员，系统任务发给当前管理员。各浏览器需要单独允许通知；通知订阅绑定当前登录会话，退出或会话到期后停止投递。

部署桌面推送：

1. 执行 `pnpm --filter @aime/server exec web-push generate-vapid-keys --json`，生成一次并妥善保存密钥对。
2. 在 `.env` 设置 `WEB_PUSH_PUBLIC_KEY`、`WEB_PUSH_PRIVATE_KEY` 和 `WEB_PUSH_SUBJECT`（真实的 HTTPS 联系页面或 `mailto:` 联系邮箱），重启 API。公钥可以传给浏览器，私钥只留在服务器。
3. 执行 `pnpm db:migrate`。新增 `automation_notifications` 保存通知事件、`web_push_subscriptions` 保存浏览器订阅；任务开关仍保存在 Mastra schedule 的 metadata 中。
4. 生产环境通过 HTTPS 同域提供 `/notification-sw.js` 与 `/api/*`，Service Worker 脚本不做 SPA 回退或长期缓存；开发环境可使用 localhost。HTTP 局域网地址不支持浏览器通知。
5. 在任务编辑窗口开启「桌面通知」并允许浏览器通知，然后保存任务。其他有权限的成员可通过管理页的「在此浏览器启用」注册自己的设备，无需任务编辑权限。

支持 Chrome/Edge、Firefox、Safari 使用的标准推送服务。移动端还需满足浏览器的安装要求（例如 iOS 的主屏幕 Web App）。操作系统或浏览器完全退出、禁用后台活动或通知时，实际到达时间由浏览器和系统控制。推送仅携带通知 ID；Service Worker 会再次校验当前账号权限后读取标题并展示。通知传输失败不改变任务执行结果，失效订阅会自动清除。页面断线后使用持久游标补收通知。

参考：[shadcn Toast](https://ui.shadcn.com/docs/components/base/toast)、[MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)、[web-push](https://github.com/web-push-libs/web-push)。

## 常见问题

- **登录、退出或 API 报来源/权限错误**：确认浏览器来源在 `WEB_ORIGIN` / `WEB_ORIGINS` 中，协议、主机和端口均需一致；修改后重启服务。管理员权限和项目成员权限仍单独校验。
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
