# 全栈插件开发接口（API v1）

插件是同仓库、随宿主构建发布的可信代码。安装和升级需要构建、迁移及重启；已安装版本可以在 **后台 → 插件管理**（`/admin/plugins`）启用或停用。

## 快速运行 Demo

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

用管理员账号打开 `/admin/plugins`，启用「个人笔记 Demo」，点击「个人笔记」进入 `/p/notebook`，或点击「笔记概览」进入 `/p/notebook/overview`。两个页面均可直接访问和刷新。创建笔记后，聊天的 Agent 选择器中选择「笔记助手」并询问笔记内容。聊天需要宿主已配置可用的语言模型；页面和 API 无需模型供应商。

Demo 包含个人笔记页面、聊天右侧栏的「个人笔记」「笔记概览」两个扩展、受会话保护的 API、`plugin_notebook_notes` 数据表、独立 npm 依赖 `slugify`、Agent、Tool 和 Skill。启用后打开聊天，点击右侧笔记或图表图标；窄屏从聊天菜单打开抽屉。侧栏无需配置模型即可使用，笔记数据与独立页面共用。用户 ID 由宿主会话或 Agent RequestContext 提供，不能通过请求体选择其他用户。

## 文件契约

```text
plugins/<id>/
  plugin.manifest.json       # 元数据、页面权限、导航、右侧栏扩展、依赖插件
  package.json               # 独立 npm 依赖
  server/index.ts            # default createServer(context): PluginServer
  server/database.ts         # default PluginDatabase，实体与迁移
  web/index.tsx              # default PluginWeb，页面与右侧栏组件映射
  skills/<skill-name>/       # 可选；建议名称带插件 ID 前缀，避免技能名称冲突
    SKILL.md
```

插件根目录只存放插件包；公共开发文档可以直接放根目录。发现脚本扫描一级目录，目录名必须与清单 ID 一致。没有某项能力时，仍提供对应入口，返回空对象或空数组。前后端入口由构建脚本生成，新增插件无需编辑宿主路由或注册表。开发中添加/删除插件或修改清单后重启 `pnpm dev`；现有页面源码可使用 Vite HMR。

## 清单

```json
{
  "id": "notebook",
  "name": "个人笔记 Demo",
  "description": "保存与查询自己的笔记",
  "version": "1.0.0",
  "apiVersion": 1,
  "dependencies": [],
  "pages": [
    {
      "path": "",
      "title": "个人笔记",
      "access": "session",
      "navigation": true
    },
    {
      "path": "overview",
      "title": "笔记概览",
      "access": "session",
      "navigation": true
    }
  ],
  "rightSidebar": [
    {
      "id": "notes",
      "title": "个人笔记",
      "access": "session",
      "icon": "notebook"
    },
    {
      "id": "overview",
      "title": "笔记概览",
      "access": "session",
      "icon": "chart"
    }
  ]
}
```

- `id`：小写字母开头，允许数字和连字符，最长 40 字符。
- `version`：`major.minor.patch`；每次发布升级应递增，迁移命令拒绝降级。
- `apiVersion`：当前为 `1`，不兼容版本在发现阶段失败。
- `dependencies`：其他插件 ID，按依赖顺序发现；缺失、循环依赖构建失败。启用依赖插件后才能启用当前插件；存在已启用依赖者时禁止停用。
- `pages`：`session` 页面挂到 `/p/<id>/<path>`，`admin` 页面挂到 `/admin/p/<id>/<path>`。`path` 为空表示首页，也支持 `notes/:noteId` 等多级参数。动态参数页面不能直接成为导航链接。
- `rightSidebar`：可选数组，默认空；一个插件可声明多个聊天右侧栏扩展。`id` 在插件内唯一，不同插件可以使用相同 ID；规则与插件 ID 相同。`access` 默认 `session`，`admin` 仅管理员可见；`icon` 可选 `puzzle`（默认）、`notebook`、`list`、`chart`。入口顺序与数组一致。

## 服务端接口

完整定义：[PluginContext / PluginServer](../packages/plugin-sdk/src/server.ts)。

```ts
import type { PluginContext, PluginServer } from '@app/plugin-sdk/server';

export default function createServer(context: PluginContext): PluginServer {
  // context.id             插件 ID
  // context.database       已初始化的宿主 TypeORM DataSource
  // context.assertEnabled  异步检查持久化启用状态
  return { api, agents, tools };
}
```

- `api`：`Hono<PluginHttpEnv>`，自动挂载到 `/api/plugins/<id>`。宿主统一处理会话、写操作 Origin 校验、128 KiB 请求体限制、启停检查和错误脱敏。
- `c.get('userId')`：当前会话用户 ID；`c.get('isAdmin')`：管理员标志。插件必须自行校验记录归属、项目成员关系和业务操作权限。**页面的 `admin` 标志不替代 API 权限检查。**
- `agents`：宿主 `BaseAgent[]`，ID 使用 `plugin:<id>:<name>`；`source: 'code'`；`model: null` 继承宿主模型配置；`agents: {}` 默认不委派。宿主 AgentService 统一列出和执行，不需要写入 Mastra Agent 数据表。
- `tools`：Mastra `createTool()` 实例数组，ID 使用 `plugin_<id（连字符转下划线）>_<name>`。宿主包装执行入口，因此已经取出的句柄在停用后也无法执行。工具进入全局配置、Agent 和 `exec` 目录，支持标准启停开关；结果使用现有通用工具展示。本版未增加任意工具配置表单或专用结果渲染器注册接口。
- `dispose`：可选的异步进程退出清理函数。`createServer` 是构造入口，不是启用回调；即使插件停用也会调用，不能在这里启动定时任务或外部副作用。本版启停控制请求与能力的可用性，不包含后台 worker 生命周期。

插件使用宿主 DataSource，不能自行关闭、初始化或开启 `synchronize`。普通共享类型可从 `@aime/shared` 导入；插件可在同仓库引用源项目模块，但内部路径不承诺兼容性。稳定入口优先使用 SDK，业务页面与逻辑继续放在插件自己的模块目录。

## 数据库接口

`server/database.ts` 默认导出：

```ts
import type { PluginDatabase } from '@app/plugin-sdk/server';
export default {
  entities: [NoteEntity], // TypeORM EntitySchema
  migrations: [CreateNotes], // MigrationInterface 构造函数，按数组顺序执行
} satisfies PluginDatabase;
```

表名、索引名建议使用 `plugin_<id>_` 前缀。迁移只能通过传入的 QueryRunner 执行。已发布迁移的名字和内容保持不变，变更结构时添加新迁移；禁止事务外 DDL，例如 `CREATE INDEX CONCURRENTLY`。

`pnpm db:migrate` 先执行认证与宿主迁移，再执行插件迁移。整个迁移命令有 PostgreSQL advisory lock，插件迁移使用事务，并按 `(plugin_id, name)` 记录在 `plugin_migrations`。迁移失败回滚本批插件 DDL 和记录。安装版本和启用状态保存在 `plugin_installations`，新安装默认停用，升级保留管理员选择。

启动时收集所有插件实体，但页面/API/AI 能力仅对版本和迁移就绪的已启用插件开放。代码版本与安装版本不一致时不允许启用。停用不会删除表、笔记或工具配置；本版不提供卸载删表和自动数据库降级。

## 前端接口

完整定义：[PluginWeb / PluginPageProps / pluginRequest](../packages/plugin-sdk/src/web.ts)。

```tsx
import type { PluginWeb, PluginPageProps } from '@app/plugin-sdk/web';
import { pluginRequest } from '@app/plugin-sdk/web';
import { Button, Dialog, ScrollArea } from '@app/plugin-ui';

function Page({ pluginId, path, params }: PluginPageProps) {
  // params.noteId 对应清单的 :noteId；path 是当前插件内路径。
  // pluginRequest<Note[]>(pluginId, '/notes') 使用同源会话请求。
  return <Button>示例</Button>;
}
export default { pages: { '': Page } } satisfies PluginWeb;
```

`pages` 支持多个页面，键必须对应清单路径，例如 `pages: { '': NotebookPage, overview: OverviewPage, 'notes/:noteId': DetailPage }`（清单也需声明相应路径），动态参数通过 `params.noteId` 传入。每个页面独立指定权限和是否出现在导航；全部随插件统一启停。插件模块通过动态 import 按需加载。页面处于宿主会话、主题和布局中；ErrorBoundary 隔离页面渲染错误。复用 `@app/plugin-ui` 提供的 Dialog、Button、Input、PasswordInput、ScrollArea 等组件，通知使用 `sonner`。

每个插件可以在自己的 `package.json` 声明 npm 依赖和组件库。React 与 React DOM 使用 `peerDependencies`，宿主 Vite 对 React、React DOM、Router 去重。插件样式纳入 Tailwind 扫描，其他组件库样式应在插件入口导入并避免全局 reset。Node 原生扩展及系统库仍需在 Docker 构建阶段提供。本版不支持后台上传源码后即时安装依赖。

### 多个右侧栏扩展

```tsx
import type { PluginWeb, PluginSidebarProps } from '@app/plugin-sdk/web';
import { ScrollArea } from '@app/plugin-ui';

function Notes({
  pluginId,
  sidebarId,
  threadId,
  projectId,
  onClose,
}: PluginSidebarProps) {
  // pluginId / sidebarId 标识当前扩展；threadId / projectId 是可选的聊天上下文。
  // API 使用 pluginRequest；服务端仍须验证会话、资源归属和访问权限。
  return <ScrollArea className="min-h-0 flex-1">笔记内容</ScrollArea>;
}
function Overview(props: PluginSidebarProps) {
  return <div className="p-4">笔记概览</div>;
}
export default {
  pages: {},
  rightSidebar: { notes: Notes, overview: Overview },
} satisfies PluginWeb;
```

`rightSidebar` 的组件键与清单的 `id` 一一对应。宿主负责入口、标题、关闭按钮、伸缩布局、移动端 Sheet、按需加载和错误隔离；插件渲染内容区，长内容使用 `ScrollArea`。`onClose()` 供组件内部操作完成后关闭使用。尚未创建聊天时 `threadId` 为 `undefined`，个人聊天的 `projectId` 为 `undefined`；这些标识仅供上下文使用，不能替代服务端权限检查。当前只开放聊天工作区的右侧栏插槽。

同一插件的侧栏入口统一随插件启停，管理员权限按每个扩展分别判断；关闭或切换侧栏会卸载内容，再次打开重新加载数据。停用正在显示的插件时立即卸载内容并回到文件视图，聊天自身保持挂载。两个 Demo 扩展复用现有笔记 API 和表，本次增加侧栏不需要新的数据库迁移。

## Skill 接口与启停语义

技能随构建复制，并在启动时同步到 `WORKSPACE_ROOT/.agents/skills/plugins/<id>/...`，由宿主管理，不能通过通用 Skill 管理接口更新或删除。已启用插件的技能参与自动发现和自定义 Skill 选择。停用后新发现、列表及后续文件读取均被拒绝；已进入模型上下文的文字无法撤回。

启停写入数据库后，新 API 请求、新 Agent 解析和每次插件 Tool 执行立即重新检查；多个服务实例共享状态。已开始执行的请求允许结束。页面开关立即更新当前导航，其他浏览器在窗口聚焦或最多约 15 秒的可见页面轮询后同步；前端检查不作为权限边界。停用不卸载已经加载的 JavaScript。

可信插件可以执行任意宿主进程代码；这是一套扩展接口，不是第三方代码沙箱。

## API 一览

| 方法   | 路径                              | 权限 / 行为                                                           |
| ------ | --------------------------------- | --------------------------------------------------------------------- |
| GET    | `/api/plugins`                    | 登录；管理员看到全部插件，普通用户只看到启用插件                      |
| PUT    | `/api/plugins/:id/enabled`        | 管理员、同源；请求体 `{ "enabled": true }`，返回更新后的 PluginStatus |
| GET    | `/api/plugins/notebook/notes`     | 登录且插件启用；最新 50 条个人笔记                                    |
| POST   | `/api/plugins/notebook/notes`     | 登录且插件启用；`{ "title": "...", "content": "..." }`                |
| DELETE | `/api/plugins/notebook/notes/:id` | 登录且插件启用；只能删除自己的笔记                                    |

宿主保留插件 API 下的 `PUT /enabled`。常见错误码：`UNAUTHORIZED`（401）、`FORBIDDEN`（403）、`PLUGIN_DISABLED`（404）、`PLUGIN_NOT_FOUND`（404）、`PLUGIN_MIGRATION_REQUIRED`、`PLUGIN_DEPENDENCY_DISABLED`、`PLUGIN_HAS_DEPENDENTS`（409）。

## 构建、发布与验证

```sh
pnpm plugins:generate          # 校验清单，生成前后端注册入口及 Skill 资源
pnpm build                     # 自动发现 + 服务端产物 + 前端插件异步 chunk
pnpm db:migrate                # 迁移到本次发布版本
pnpm start                     # 加载已经发布的插件代码
pnpm test:plugins              # 不访问数据库的发现测试，集成测试默认跳过
pnpm test:plugins:integration  # 使用 .env 的 PostgreSQL 凭证创建临时测试库，结束后删除
```

集成测试要求数据库用户具有 `CREATEDB` 权限，只在临时数据库中操作。覆盖迁移幂等与回滚、API 权限及用户隔离、持久化启停、依赖关系、Agent 调用真实插件 Tool、`exec` 调用、旧句柄拒绝及 Skill 发现。Agent 流程使用确定性模拟模型，不等于真实供应商推理验收。

Dockerfile 已在构建阶段执行 `pnpm build` 并复制完整仓库，插件包、依赖和 Skill 资源会随镜像发布；服务端入口继续执行 `pnpm db:migrate`。前后端应发布同一份提交。插件生成文件可提交，但必须通过生成命令更新，不手工编辑。
