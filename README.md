# Aime Hub

基于 React、Express 和 Mastra 的 AI 工作空间，支持个人对话、项目协作、模型供应商管理与会话工作目录。消息由服务端持续执行，通过 SSE 同步；关闭页面不会中断正在进行的对话。

## 功能

| 模块       | 当前能力                                                                             |
| ---------- | ------------------------------------------------------------------------------------ |
| 账号与权限 | 用户名登录、注册、持久会话；管理员管理用户、角色、密码、封禁与会话撤销               |
| 模型管理   | 供应商与模型管理、OpenAI 兼容模型列表同步、能力配置、系统默认模型与思考等级          |
| 个人聊天   | 流式回复、Markdown、推理过程、图片输入、工具结果、上下文用量、错误重试与历史分页     |
| 消息队列   | 空闲时直接执行；忙碌时排队，支持编辑、拖动排序、删除、立即注入、停止与继续           |
| 工具交互   | 工具审批、用户问题与挂起恢复；后台任务状态、结果展示和单独取消                       |
| 项目协作   | owner/admin/member 角色、成员管理、共享对话、项目默认模型与共享工作目录              |
| 工作区文件 | 文件树、文件名与内容搜索、新建、重命名、删除、下载，文本/代码及图片、音频、视频预览  |
| Skills     | 后台扫描 GitHub 并批量安装技能，支持全局及个人/项目覆盖，输入 `/` 搜索并补全技能命令 |
| 界面       | 中英文随浏览器语言切换、响应式导航、可调整宽度的文件/消息检查面板、全局会话运行状态  |

## 技术栈

- **前端**：React 19、Vite 7、React Router 7、TypeScript、Tailwind CSS 4、shadcn/ui、AI Elements、AI SDK 6、Streamdown、i18next。
- **后端**：Express 5、Mastra Agent / Memory / Workspace / Background Tasks。
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

### 会话、队列与后台任务

每个线程串行执行。空闲时新消息直接运行；已有任务时新消息进入队列，可修改文字、排序或移除。标记为“立即”的消息在当前轮下一步可用时注入，若没有后续步骤则紧接当前轮执行。

- 每个队列最多 20 条消息，总序列化大小不超过 16 MiB。
- 每条消息最多附带 4 张图片，每张不超过 2 MiB；模型需支持图片输入。
- 停止当前轮会保留已生成的部分回复并暂停剩余队列，之后可继续。
- 工具请求审批或补充输入时，可在消息卡片中回应后恢复执行。
- 标题旁的后台任务入口显示任务列表，可单独取消任务。停止当前 Agent 轮次不会自动取消独立后台任务。
- 全局导航通过独立 SSE 同步会话摘要与项目运行数量，未打开的会话也会更新状态。

线程、消息、队列和任务记录会持久化。服务进程重启后不能接续原模型连接；未完成的会话会提示中断，已保存的消息和队列可供继续。详细协议见 [个人聊天](docs/personal-chat.md)。

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
│   ├── pages/               # 认证、工作台、聊天、项目及后台页面
│   ├── components/          # chat、file-manager、model-selector、UI 等复用组件
│   ├── features/            # 认证会话、模型目录等共享逻辑
│   ├── layouts/             # 应用布局与导航
│   └── i18n/                # 语言配置与翻译资源
└── server/src/
    ├── modules/             # auth、providers、models、projects、threads、files、skills 等
    ├── mastra/              # Mastra 实例、存储和工具
    └── middleware/          # 权限、来源检查与错误处理
packages/
├── auth/                    # Better Auth 配置、插件与认证迁移
├── db/                      # TypeORM 业务实体、数据源与显式迁移
└── shared/                  # 共享类型、校验规则与环境加载
scripts/                     # 初始化、迁移、目录更新及测试
docs/                        # 设计与模块文档
```

前后端按业务模块组织，页面专属组件就近存放，跨页面交互放在 `components/`。认证表由 Better Auth 管理，业务表由 TypeORM 管理，线程和消息由 Mastra 管理。TypeORM `synchronize` 关闭，API 启动时检查待执行迁移，不会自动修改认证或业务表结构。

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
