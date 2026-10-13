# Aime Hub 使用与管理参考

[返回简体中文 README](../README.md) · [English README](../README.en.md)

本页承接 README 中的详细操作、权限边界和实现说明。安装与环境变量请先阅读 README；容器部署见 [部署说明](deployment.md)。本页当前仅提供简体中文。

## MCP 与自动化

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

## 使用说明

生产环境使用 Dockerfile + Docker Compose，支持 Dokploy 从 Git 自动部署。容器运行环境、HTTPS、持久化和管理员初始化见 [部署说明](deployment.md)。

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

- 每条消息最多附带 4 个文件；作为模型内联输入的图片不超过 2 MiB，且模型需支持图片输入。其他附件的处理见 `apps/server/src/modules/assets/attachments.ts`。
- 停止当前轮会保留已生成的部分回复，同时清空待处理消息。
- 工具请求审批或补充输入时，可在消息卡片中回应后恢复执行。
- 标题旁的后台任务入口显示任务列表，可单独取消任务。停止当前 Agent 轮次不会自动取消独立后台任务。
- 全局导航通过独立 SSE 同步会话摘要与项目运行数量，未打开的会话也会更新状态。

线程、已消费的消息和任务记录会持久化。原生待处理队列由当前服务进程持有，重启后不会恢复；未完成的会话会提示中断，已保存的消息仍可查看或重试。详细协议见 [个人聊天](personal-chat.md)。

### 项目协作

项目创建者成为 owner；owner/admin 管理项目配置及成员，member 参与共享对话。项目内所有会话使用同一个项目工作目录。服务端按项目成员身份校验会话、事件与文件访问。

删除会话会保留其工作文件；删除项目也保留聊天和文件，但撤销项目访问。存在运行任务、排队消息或活动后台任务时会限制删除。角色和接口边界见 [项目模块](projects.md)。

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

项目会话共享 `projects/<projectId>/` 下的工作区。默认使用本地目录，也可在创建项目时选择 AgentFS 或组合挂载；AgentFS 数据库位于挂载目录旁，备份时应覆盖整个 `WORKSPACE_ROOT`。技能目录应包含 `SKILL.md`，可与脚本、参考资料一起存放；支持嵌套目录分组，技能 ID 和 `/` 命令名取技能包目录名。扫描遇到 `SKILL.md` 后即将该目录视为技能包，不再继续扫描包内子目录。全局技能目录位于 **`WORKSPACE_ROOT/.agents/skills`**。

在输入框键入 `/` 可按名称、描述与目录分组查找技能，通过方向键、Enter、Tab 或点击补全。目录中的有效技能与 Agent 运行时共用读取规则，技能原文件不会因名称规范化被改写。

会话右侧面板可切换 **文件** 和 **原始消息**，窄屏使用抽屉。文件支持多标签预览及下载；文本预览上限为 512 KiB，超出部分可下载查看，未知二进制文件提供下载。文件操作受当前会话的工作目录及权限约束，不提供任意服务器路径访问。

### 代码语义检查（LSP）

支持工具调用的会话会通过 Workspace 自动获得 `lsp_inspect`，与 `read_file`、`grep` 一起使用。服务端已包含 TypeScript/JavaScript 语言服务和协议依赖，Docker 构建也会携带这些依赖，无需在每个项目中重新安装语言服务。其他语言需要在服务器或容器中安装对应语言服务及运行时；不会在查询时自动下载。

调用时提供文件路径、从 1 开始的 `line`，以及该行原文的 `match`；在目标符号前插入且仅插入一个 `<<<`。例如：`{ "path": "src/main.ts", "line": 2, "match": "const total = <<<count;" }`。普通工作区支持相对路径或工作区内的绝对路径，组合挂载支持 `/挂载名/文件路径`。输入路径会校验当前工作区边界和符号链接目标。

结果预览展示类型/文档、当前行诊断、定义及实现位置；语言服务不支持的字段可能缺省。定义可能指向依赖包的声明文件。LSP 直接读取服务器上已挂载的文件，并非独立安全沙箱；项目配置和依赖仍需可信。语言服务按需启动，每个 Workspace 最多保留 4 个客户端，并随会话运行资源销毁而关闭。它属于 Workspace 原生工具，不列入后台应用工具注册表；配置位于 `apps/server/src/modules/threads/workspace-lsp.ts`。

### Skills 管理

`apps/server/src/mastra/skills/` 存放随服务发布的全局内置技能，每个包需包含 `SKILL.md`。构建时会将完整目录复制到 `apps/server/dist/mastra/skills/`；服务每次启动、接受请求之前，将其中的技能包同步到 `WORKSPACE_ROOT/.agents/skills/builtin/`。开发模式直接读取源码目录，生产模式读取构建产物，用户无需安装。新增、更新或删除内置包后，重新部署或重启服务即可刷新；生产模式需先重新构建。

`builtin` 是服务维护的保留分组，每次启动按发布内容整体刷新，清除旧资源。需要自定义时，在个人或项目技能目录放置同名包覆盖全局版本。其他全局分组以及个人、项目技能不参与此同步。复制使用暂存目录，准备完成后替换；复制失败时保留原版本并终止启动。内置技能和其他全局技能共用目录发现与 Agent 技能选择机制。

用户通过左上方的“Skills 管理”（`/skills`）管理自己的个人技能，管理员在 `/admin/skills` 管理全局技能。两处复用同一套管理组件，支持查看、搜索、删除及通过“从 GitHub 导入”扫描仓库并按文件夹批量勾选安装。个人目录、扫描缓存和操作按当前登录用户隔离。点击技能条目可在弹窗中预览 `SKILL.md`，或切换查看完整原文。

仓库根目录存在 `SKILL.md` 时，默认显示一个“完整技能包”安装项，保留整个仓库结构、共享脚本、模板和包内子技能；子入口可展开查看，不再单独勾选。没有根入口的仓库作为技能合集，按目录选择安装；遇到包入口后不再拆分其内部子入口。明确指定的文件夹或文件链接仍保留该范围，因此依赖仓库共享资源的包应使用仓库根地址。管理页面和内置 Python 安装器遵循同样的规则。

GitHub 来源的组标题提供仓库跳转按钮，删除按钮左边提供一键更新。更新按保存的原始分支、路径和安装模式整体替换该组目录，并清除旧文件：完整技能包保持原入口和安装目录，子技能始终随包更新；技能合集安装原范围下最新的全部有效技能（包含上次未选择或后来新增的技能），不会因为上游新增根入口而切换模式。完整包入口消失或无效、原路径消失或拉取失败时保留原组；替换失败时恢复原组。一个组曾从多个路径导入时会更新所有原路径。旧版来源记录会结合现有安装识别模式并在成功更新后保存；没有来源记录的旧安装需先补填原始 GitHub 地址。支持以下来源：

已安装技能的分组支持展开、收起和整组删除。删除确认会列出该组全部技能，包括搜索暂时隐藏的条目；分组内容变化时需刷新后重新确认。删除仅作用于确认清单中的技能包，独立子分组及目录中的其他文件会保留，空分组目录会自动清理。

| 输入                                                       | 扫描范围                       |
| ---------------------------------------------------------- | ------------------------------ |
| `owner/repo` 或 `https://github.com/owner/repo`            | 默认分支的整个仓库             |
| `https://github.com/owner/repo/tree/<ref>/<目录>`          | 指定分支或版本下的目录及子目录 |
| `https://github.com/owner/repo/blob/<ref>/<目录>/SKILL.md` | 指定技能及其同目录资源         |

导入功能需要 API 服务器安装 Git。首次直连公开 GitHub 仓库，拉取失败时依次通过 `https://githubproxy.cc/`、`https://ghfast.top/` 重试，将加速源前缀加在原始 `https://github.com/<owner>/<repo>.git` 地址之前；任一来源成功后停止重试。导入和整组更新共用此机制。重试前清理失败下载的临时目录，保留原始 GitHub 来源、分支与路径；取消操作、缺失路径、无效仓库内容或未安装 Git 时不会切换加速源。扫描固定仓库提交，安装从该次扫描的快照读取，目标目录为：

```text
<WORKSPACE_ROOT>/.agents/skills/<owner>/<repo>/<skill-name>/SKILL.md
```

安装会保留技能目录内的脚本和参考文件，跳过符号链接与子模块，并校验技能格式和路径。不限制仓库大小、文件数量、技能数量或单文件大小。已有目标目录不会被静默覆盖；批量安装发生错误时回滚本批次写入。每次安装结束（成功或失败）立即删除下载的临时仓库，成功后关闭导入面板；再次导入需重新扫描。尚未安装的扫描结果保留 15 分钟，关闭面板、扫描取消或失败、过期以及服务退出时都会清理临时仓库。安装后的全局技能可被个人与项目聊天发现。

### 后台 Agent 管理与聊天选择

管理员在 **管理后台 → Agent 管理**（`/admin/agents`）创建、编辑和删除自定义 Agent，配置系统提示词、模型、应用工具与后台已安装的 Skills。代码 Agent 定义在 `apps/server/src/mastra/agents/`，在 `index.ts` 注册；示例 `code:assistant` 是通用助手。代码配置直接从注册表读取，不写入 Agent 数据表，管理页仅提供只读详情，服务端也拒绝修改和删除。按 ID 查找时优先匹配代码注册表，未命中才读取数据库；已有同 ID 数据只展示和使用代码配置。自定义 Agent 的 ID 由服务端生成并避开代码已占用的 ID，创建接口不接受客户端指定 ID。

自定义 Agent 使用 Mastra 原生 `agents` storage domain，记录与版本分别保存在 `mastra.mastra_agents` 和 `mastra.mastra_agent_versions`；每次保存创建新版本，无需新增数据表。自定义 Agent 创建时为草稿，管理页通过发布开关切换 `draft` / `published`；只有 `published` 状态可进入可用列表、设置为默认项或构建运行实例，草稿和归档项均不可使用。编辑已发布项会保持发布状态并更新激活版本，运行中的会话仍保留原配置。修改、删除和状态切换携带版本 ID，单服务进程内串行检查以拒绝过期编辑；默认项需先更换后才能删除或取消发布。

后台默认 Agent 写入 `settings` 的 `agents:defaults`，值为 `{ defaultAgentId }`；没有设置或默认项被外部删除、取消发布时回退到代码通用助手。`GET /api/rpc/agents/available`（HTTP 形式 `/api/agents/available`）向已登录用户返回 `{ defaultAgentId, agents }`，仅含可选项的 ID、名称、说明、模型和来源。配置管理与默认项写入要求管理员权限，写操作校验 Origin。

聊天输入框上方可选择 Agent，选择保存到现有个人配置 `settings[chat:user:<userId>].agentId`，刷新或开启下一次聊天时恢复。选择“跟随系统默认”保存 `null`；未指定 Agent 时，配置入口 `AgentService.getConfig(id)` 解析默认项。项目聊天也保留个人 Agent 选择，不修改项目共享模型配置。固定模型优先于聊天模型；模型留空则沿用聊天模型和现有模型默认解析规则。API 空模型为 `null`，原生版本仍以 `model: []` 表示未固定模型，运行前才解析实际模型。

运行时调用 `AgentService.getAgent(id, { model, tools, memory, workspace, goal, instructions, ... })` 获取构建后的 Mastra `Agent`；`model` 等依赖由当前会话提供，`instructions` 可覆盖默认提示词，工具从传入集合中按配置筛选，`versionId` 可固定已解析的数据库版本。每个聊天原生会话使用独立实例，加载对应提示词、遵守全局启停状态的应用工具，以及当前模式允许的 `.agents/skills` 目录技能。代码 Agent 统一自动加载 Skills；自定义 Agent 可选择“自动”或“自定义”，新建时默认自动。自动模式按会话权限加载全部可用技能：个人会话合并全局与当前用户的技能，项目会话合并全局与当前项目的技能，同名时个人／项目技能覆盖全局技能；不会混入其他用户或项目的技能。自定义模式仅加载后台勾选的全局安装目录，同名的个人／项目技能不会替换固定选择，空选择表示不加载任何技能。Skills 以原生 `workspace` provider 引用 `{ type: 'provider', provider: 'installed-skills', config: { skillsMode, skillPaths, disabledTools } }` 纳入版本，无需数据库迁移。未存储模式的历史版本，有选择时按自定义读取、空选择时按自动读取。运行时使用 Workspace 的动态 `skills` 目录解析器，每次执行重新发现可用安装目录，自动模式随技能增删更新；自定义目录被移除时提示技能不可用。工作区和浏览器工具继续由聊天运行时提供。排队消息、工具恢复和正在运行的任务使用已固定的配置；在运行、排队、后台任务、工具等待或活跃目标结束后，可切换 Agent 或加载更新后的配置版本。

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

## 请求日志

后端默认通过 Undici hook 输出模型接口（`/chat/completions`、`/responses`）实际发送的完整请求 body，日志以 `[chat:request]` 开头，包含请求 ID 和接口地址。每次重试、工具调用后的续问，以及标题生成等辅助模型请求都会单独记录；body 发送中断时标记为 `incomplete`。日志保留正文中的完整对话、附件及工具参数，地址中的查询参数和请求头不输出。

管理员可在 **管理后台 → 请求日志**（`/admin/request-logs`）查看这些请求。新日志异步保存到 PostgreSQL 的 `chat_request_logs` 表，重启后保留；部署更新时先运行 `pnpm db:migrate`。捕获器从实际请求的 `X-THREAD-ID`、`X-RESOURCE-ID`、`X-USER-ID`、`X-PROJECT-ID` Header 提取标识，分别存入带索引的 `thread_id`、`resource_id`、`user_id`、`project_id` 字段；缺失 Header 和旧日志对应字段为 `NULL`，不会补录。页面支持按模型、接口、请求 ID 及上述标识搜索，也支持四个标识的组合精确筛选、请求体发送状态筛选、分页和自动刷新。详情展示关联标识，按需加载完整原文，提供 JSON 格式化和原文复制；浏览历史页或详情时自动刷新暂停。状态仅表示请求体是否完整发送，不代表模型响应成功。历史控制台输出不会补录。

请求发送后立即入库，响应完成或中断后更新同一条记录的 `duration_ms`、`http_status`、`response_status`、响应类型、编码、接收字节数及响应内容。耗时从 Undici 创建请求开始计时，包含连接、发送及完整流式接收过程；每次 HTTP 重试单独计时。响应通过传输层分块捕获，JSON 与 SSE 保留原始文本，gzip / deflate / brotli 自动解压；无法还原为 UTF-8 文本的内容保存原始接收字节的 Base64。`response_bytes` 统计解压前的接收字节数，请求发送状态与响应接收状态分别展示，HTTP 错误响应也会保留。列表不加载请求或响应正文，详情提供请求 / 响应切换和复制；等待响应完成时详情自动更新。旧日志的响应与耗时字段为 `NULL`。

## 用量统计

管理员在 **管理后台 → 用量统计**（`/admin/usage`）查看用户、项目和供应商／模型的 tokens 消耗。可选择近 7／30／90 天或自定义日期（最多 366 天），按用户 ID、项目 ID、供应商 ID、模型 ID 组合筛选，并切换统计时区。排行展示前 100 项，点击名称可筛选；个人聊天归入“个人聊天”。页面提供每日趋势、可翻页的 GitHub 风格热力图（卡片占满可用宽度，默认连续 12 个完整月份，可切换 3／6／12 个月，每次翻页移动同样数量的月份；按天汇总，沿用用户／项目／模型筛选，独立于上方日期范围）、分页步骤记录和详情。

数据来自 Mastra runtime 的 `onStepFinish`，直接读取每一步的 `event.usage`，独立保存在 `usage_records` 表，不读取请求日志或 HTTP 响应正文。每步在执行前分配唯一 ID，同一记录重复提交不会重复计数；项目消息按 runtime 当前处理的消息作者归属。模型保留配置引用和 runtime 实际返回的模型 ID，模型 ID 相同但供应商不同的用量分开汇总。步骤耗时包含模型响应和该步工具执行。输入、输出及总量独立保存；缓存命中、缓存写入和推理 tokens 为细分项，不重复叠加到总量。没有返回的值保存为 `NULL`，展示为 `—`；汇总仅累加已知值并显示总量返回覆盖率。

首次使用需执行 `pnpm db:migrate` 并运行更新后的服务。仅统计接入后完成的对话模型步骤（包含工具循环和该 runtime 路径的自动化）；历史用量不回填。标题生成、记忆压缩、目标判断等独立辅助调用，以及未触发步骤完成回调的中断请求不在当前统计范围内。数据库写入失败会记录不含对话内容的错误日志，不中断聊天；此类步骤可能缺失，不应将这里的汇总作为供应商账单。

接口 `usage.summary` / `usage.records` 同时提供 `GET /api/admin/usage` 和 `GET /api/admin/usage/records`，HTTP 与 RPC 都仅允许管理员访问。查询用 `from`、`to`（含当天，`YYYY-MM-DD`）和 IANA `timezone` 指定时间范围；筛选 ID 精确匹配，项目筛选 `__none__` 表示个人聊天。记录采用开始时间和 ID 的游标分页，刷新保留当前页。删除用户、项目或供应商后保留历史用量及原 ID。

## 路由与 API 架构

页面使用 `apps/web/src/router.tsx` 中的 TanStack Router 路由树。页面仍按业务存放于 `pages/`，通过懒加载拆分；动态链接使用 `$projectId` / `$threadId` 和类型化 `params`，登录、会话和管理员布局共用原有会话状态。

业务请求的唯一契约位于 `packages/shared/src/rpc/`，输入复用 Zod 校验，输出声明共享 DTO。后端在 `apps/server/src/modules/<业务>/rpc.ts` 实现，统一由 Hono 挂载：

- `/api/rpc/*`：前端通过 `apps/web/src/lib/rpc.ts` 的 `api` 调用，输入输出从契约推导；浏览器不导入后端实现或数据库代码。
- 原有 `/api/threads`、`/api/projects`、`/api/admin/providers` 等 HTTP 地址：同一套过程通过 oRPC OpenAPIHandler 提供兼容入口，不重复实现业务逻辑。
- `/api/auth/*`：Better Auth 原生 Web Request handler，用户管理继续由其 admin 插件负责。
- `/api/threads/events`、`/api/threads/:threadId/messages`：Hono SSE，保留独立订阅、心跳、权限复查和断开清理。取消订阅不会停止服务端执行。
- `/api/threads/:threadId/files/raw`：Hono 文件响应，保留权限检查、Range / HEAD、下载与内容安全响应头。

新增业务接口先增加共享契约，再实现对应模块过程，最后通过类型化客户端调用。会话和管理员检查在 oRPC 中间件中执行，非安全 HTTP 方法（包括 RPC POST）要求匹配 `WEB_ORIGINS` 的来源白名单；HTTP 和 RPC 共用业务权限检查及稳定错误码。API 时间字段显式转换为 ISO 字符串，避免 RPC 的 Date 支持改变既有 DTO。

框架参考：[TanStack Router](https://tanstack.com/router/latest/docs/quick-start)、[Hono Node.js](https://hono.dev/docs/getting-started/nodejs)、[oRPC Contract First](https://v1.orpc.dev/docs/contract-first/implement-contract)。

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
