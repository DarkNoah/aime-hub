# 项目模块 PRD

## 1. Executive Summary

**Problem Statement**：现有个人聊天将线程权限、模型偏好与工作目录绑定到用户，无法承载项目成员共享的聊天和文件上下文。

**Proposed Solution**：增加项目、成员和项目仪表盘；将现有 ThreadService、ChatPanel 和 Mastra 原生线程扩展为同时支持 `user:<userId>` 与 `project:<projectId>`。依据 `harness.md`，首期包含团队成员。

**Success Criteria**：

- 创建项目后，创建者自动成为唯一 owner；项目列表只返回当前用户参与且未删除的项目。
- 非成员无法读取或变更项目线程、历史、队列，也无法订阅 SSE；移除成员后关闭其现有订阅。
- 同一项目线程的两个成员收到相同的服务端消息 ID、内容与运行状态；离开页面不会停止执行。
- 项目聊天模型按本次选择、项目默认、系统默认解析，不读取个人偏好；项目线程共用项目工作目录。
- 个人聊天现有回归测试继续通过；项目权限、共享运行、工作目录与模型隔离新增回归验证。

## 2. User Experience & Functionality

**User Personas**：组织项目的创建者、维护项目的 admin、共同使用聊天的 member。

**User Flow**：进入项目列表 → 创建项目或打开已加入的项目 → 添加成员／设置共享默认模型 → 新建或进入项目聊天 → 多成员共同发送与查看回复 → 返回仪表盘管理聊天。普通成员仅看到自己有权使用的操作。

**User Stories / Acceptance Criteria**：

- As a 创建者, I want to 创建并维护项目 so that 相关聊天有统一入口。
  - `/projects` 展示项目列表；通过 Dialog 创建项目或编辑名称；项目 ID 自动生成 16 位 nanoid。
  - `/projects/:projectId` 展示项目线程、成员及设置；更新单项保留列表分页和滚动位置。
  - 左侧“项目”可折叠；首次加载 5 个项目，向下滚动或点击“加载更多项目”每次追加 5 个。
  - 点击项目名称展开聊天，首次按需加载 5 条，列表最多占 5 行高度；超出后向下滚动或点击“更多聊天”分页追加。仪表盘和新聊天使用独立入口。
  - 项目侧栏、移动端导航与项目页面共享会话内列表缓存；折叠保留聊天分页和滚动位置，创建、重命名、删除只更新相应条目。
  - owner 可删除项目；有运行或排队线程时拒绝删除。软删除项目后所有入口失效，保留聊天记录与工作文件。
- As a 项目管理者, I want to 管理成员 so that 项目数据只对参与者开放。
  - owner 可添加 admin/member、调整角色和移除其他成员；admin 只能添加或移除 member。
  - 创建者不能被移除或降级；首期不提供所有权转移。
  - 用户选择只返回匹配的账户 ID、名称与用户名，不返回邮箱和认证信息。
- As a 项目成员, I want to 在项目内共同聊天 so that 团队共享相同上下文。
  - 所有成员可以新建、发送、停止和恢复项目线程；成员可重命名或删除自己创建的线程，owner/admin 可管理全部线程。
  - `/projects/:projectId/threads/:threadId` 复用 ChatPanel；直接访问 `/threads/:threadId` 时识别并跳转项目归属。
  - 队列、历史分页、流式恢复、附件与个人聊天共用实现；普通成员不会因操作聊天设置而修改全项目默认。
- As a 项目管理者, I want to 设置项目默认模型 so that 新聊天使用一致配置。
  - 设置通过现有模型选择器、思考等级控件编辑；个人默认配置与项目默认互不影响。

**Non-Goals**：本阶段不实现邀请邮件、所有权转移、公开分享、组织层级、独立文件管理页面、项目指令编辑、多进程分布式队列。

## 3. AI System Requirements

**Tool Requirements**：复用已安装的 Mastra、Memory、Observational Memory、Workspace、AI SDK 与模型供应商服务。项目管理目录为 `WORKSPACE_ROOT/projects/<projectId>/`，文件存储按下面的路径模式配置；项目 `.agents/skills` 覆盖同名全局 skill，不加载个人 skills。

**Evaluation Strategy**：使用本机确定性模型服务检查双用户消息一致、排队串行、停止与恢复、模型优先级和权限。真实供应商的回答质量、多模态及长上下文 OM 验收另行记录，不能由模拟测试替代。

## 4. Technical Specifications

**Architecture Overview**：`modules/projects` 负责项目与成员；`modules/threads` 负责统一线程运行。ThreadService 从持久化 resourceId 推导归属，委托项目模块检查成员权限。HTTP 提交与 SSE 订阅使用相同的线程实例和消息队列。

**Integration Points**：

- TypeORM 增加 `projects`、`project_members` 及迁移；业务表包含 created_at、updated_at、deleted_at，不定义认证用户实体。
- Better Auth 继续管理登录用户；项目成员关系是业务数据。系统管理员身份不隐式获得所有项目访问权。
- Mastra 继续持久化线程、消息和运行 metadata，不新增业务线程表。线程保存保留 workspace、createdBy 和 Mastra metadata。
- `/api/projects` 提供项目 CRUD；`/:projectId/members` 管理成员；`/:projectId/users` 搜索可加入的账户；`/:projectId/preferences` 维护默认模型。
- `/api/threads` 支持 projectId 过滤和创建；不传 projectId 保持个人列表。后续线程操作从服务端归属鉴权，不信任客户端 resourceId 或路径。
- 项目与线程列表均接受 `page`、`perPage`（1–50）；不传时分别保持 20、10 条默认值，项目界面使用 5 条分页。
- 技术栈沿用 Vite/React、Express、PostgreSQL、TypeORM、Better Auth 与 Mastra；预算和交付期限尚未指定。

**Security & Privacy**：所有接口要求登录，写入校验 Origin；项目权限在每次操作和 SSE 订阅时检查。移除成员立即断开项目订阅，SSE 定期复查会话和权限。用户搜索仅允许项目管理者，参数化查询且限制数量。项目、个人目录和技能发现保持隔离。

## 5. Risks & Roadmap

**Phased Rollout**：MVP 为本文件首期范围；v1.1 可增加所有权转移、文件管理与项目指令；v2.0 根据部署需求增加共享执行锁、跨进程事件与审计。

**Technical Risks**：项目成员并发提交需复用线程锁；成员撤销必须处理已连接 SSE；项目删除需阻止运行期间移除归属。当前服务仅支持单进程执行；迁移需在启动前运行；真实供应商调用成本与稳定性需单独验收。

### 实施验证记录

- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。Lint 保留现有 UI／AI Elements 文件的 17 条 Fast Refresh 警告；构建仍有第三方注释及大 chunk 提示。
- 为 `pnpm test` 注入本机 `TEST_DATABASE_URL` 后，103 项测试全部通过、无跳过。数据库测试使用并清理随机 schema，未迁移现有业务 schema。
- `scripts/projects.integration.test.ts` 使用真实 PostgreSQL、Better Auth 与 HTTP，验证角色、CSRF、默认模型隔离、撤销现有 SSE、成员重新加入、软删除和非成员拒绝；此测试的线程执行器使用确定性内存 fixture。
- `scripts/threads.integration.test.ts` 使用真实 Mastra 原生 PostgreSQL 存储、Agent 和本机 OpenAI 兼容测试服务，验证个人与项目线程、双用户 SSE、相同历史消息 ID、项目共享工作目录。
- `scripts/project-threads.test.ts` 覆盖所有线程操作的项目权限、成员并发串行运行、撤销订阅、删除运行中项目的拒绝、工作目录和 skills 隔离。现有个人聊天回归继续通过。
- 浏览器使用独立测试服务，实际完成创建项目、添加成员、保存项目思考等级、发送项目消息、刷新与共享历史恢复、统一 `/threads/:id` 入口跳转、成员界面权限，以及 390px 窄屏仪表盘与聊天检查。浏览器检查期间没有控制台错误。
- 浏览器回复及集成模型回复来自本机测试 fixture，未调用真实供应商；真实模型多模态、成本与长上下文 OM 尚需验收。
- 正式启动前先运行 `pnpm db:migrate`，新增项目与成员表。当前仍要求单服务进程运行；不支持跨进程线程锁和广播。

### 项目侧栏分页验证（2026-10-02）

- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过，Lint 仍为现有 17 条警告；开启本机数据库集成测试后，107 项测试通过，无跳过。
- 新增列表缓存回归，覆盖 5 条分页、项目间线程隔离、请求合并、编辑/删除与在途响应合并、取消及失败重试；真实 HTTP 测试验证 12 条数据按 5/5/2 返回和分页参数边界。
- 隔离浏览器 fixture 中实测 12 个项目、每个 12 条聊天：首次 5 条，滚动追加到 10/12 条，末页停止；折叠后保留 12 条缓存及滚动位置；聊天重命名同步到仪表盘。390px 移动端选择项目聊天后关闭导航，无横向溢出。

### 项目列表归档与置顶（2026-10-07）

- 项目列表与侧栏保留“新建聊天”快捷按钮，其余行操作集中在“更多”菜单中：项目管理者可编辑名称、归档或取消归档，所有成员可置顶或取消置顶。置顶仅影响当前用户，保存在成员关系中；归档对所有成员生效。
- 默认列表和侧栏隐藏已归档项目；项目列表中的“已归档”页签支持访问和恢复。归档保留成员、模型配置、聊天与工作文件，不停止聊天执行或撤销访问权限。列表局部更新，保留已加载分页和聊天缓存。
- 部署前运行 `pnpm db:migrate`，迁移 `ProjectListState1780000003000` 为项目增加 `archived`、成员增加 `pinned`，历史数据默认均为 `false`。列表接口支持 `status=active|archived|all`（默认 `active`），`PATCH /api/projects/:projectId` 支持 `archived`，`PATCH /api/projects/:projectId/pin` 接受 `pinned`。

### 项目文件存储（2026-10-07）

- 创建项目使用 Dialog，默认选择简单路径模式。简单模式只选择 LocalFilesystem 或 AgentFS，两种模式都不填写本地目录或数据库路径。当前编辑 Dialog 仍只修改项目名称。
- `<workspace>` 指服务端 `WORKSPACE_ROOT`。简单模式目录为 `<workspace>/projects/<projectId>/`；AgentFS 数据库为同级 `<workspace>/projects/<projectId>.db`。
- 复合模式配置 1–16 项，每项仅保存 `provider` 与 `mountPath`。`mountPath` 是单层名称，如 `local`、`data`、`tmp`，不带 `/`，不能使用 `.`、`..`、反斜杠或控制字符，最多 64 个字符，不区分大小写判重。第一项 LocalFilesystem 默认名为 `local`，新增项自动使用不重复名称。
- 复合模式每项的物理目录为 `<workspace>/projects/<projectId>/<mountPath>/`；AgentFS 数据库为 `<workspace>/projects/<projectId>-<mountPath>.db`，放在挂载目录外。Mastra [manual composition](https://mastra.ai/docs/sandbox/filesystem#manual-composition) 的 `CompositeFilesystem` 使用 `/<mountPath>` 路由文件工具；终端工作目录为项目目录，使用相对路径 `<mountPath>/file`。
- AgentFS 由服务端运行 `agentfs mount --foreground --auto-unmount` 真实挂载，macOS 使用 NFS、Linux 使用 FUSE。服务端 PATH 中须有 `agentfs`（本次验证为 0.6.4，与 SDK 一致），并具备对应系统挂载能力。数据库通过独立短进程初始化，释放 SDK 文件锁后再挂载。所有读写均通过挂载目录，文件工具、文件侧栏和 LocalSandbox 访问同一份文件。
- 挂载在首次访问时启动，由单服务进程共享至正常关闭；关闭单个请求或聊天 Workspace 不会卸载其他请求正在使用的存储。服务停止后统一卸载；挂载失败、丢失、挂载点非空或被其他进程占用都会报错，不退回普通本地目录。异常强杀后若残留挂载，需要先卸载再重启。
- 创建接口保存 `metadata.workspace`；详情接口返回配置，修改名称和模型偏好保留配置。没有此字段的历史项目默认使用简单 LocalFilesystem。直接使用上述 `projects/` 布局，不执行旧目录或数据库迁移。存储初始化、文件系统组合与 AgentFS 挂载生命周期统一放在现有 `modules/threads/workspace.ts` 中。
- 文件访问前检查项目成员权限；支持列表、预览、搜索、增删改及下载，预览最多 512 KiB，原生下载支持 Range。挂载节点不能通过文件侧栏删除或重命名，符号链接检查沿用本地文件边界。项目 `.agents/skills` 在挂载完成后读取，不加载成员个人 skills。
- 验证真实挂载：`TEST_AGENTFS_MOUNT=1 node --import tsx --test scripts/workspace-files.test.ts`。使用临时数据库与挂载点，覆盖终端双向读写、复合目录、并发共享、关闭/重挂载持久性和 HTTP 下载；未设置该变量时跳过需要系统挂载权限的部分。
