# 全栈插件开发接口（API v1）

插件是同仓库、随宿主构建发布的可信代码。安装和升级需要构建、迁移及重启；已安装版本可以在 **后台 → 插件管理**（`/admin/plugins`）启用或停用。

## 快速运行 Demo

Demo 默认在 `plugins/notebook/plugin.manifest.json` 中设置了 `"enabled": false`，因此不会加载或出现在插件管理中。要运行 Demo，先改为 `"enabled": true`，再执行：

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

用管理员账号打开 `/admin/plugins`，启用「个人笔记 Demo」，点击「个人笔记」进入 `/p/notebook`，或点击「笔记概览」进入 `/p/notebook/overview`。两个页面均可直接访问和刷新。创建笔记后，聊天的 Agent 选择器中选择「笔记助手」并询问笔记内容。聊天需要宿主已配置可用的语言模型；页面和 API 无需模型供应商。

Demo 包含个人笔记页面、聊天右侧栏的「个人笔记」「笔记概览」两个扩展、受会话保护的 API、`plugin_notebook_notes` 数据表、独立 npm 依赖 `slugify`、Agent、Tool 和 Skill。启用后打开聊天，点击右侧笔记或图表图标；窄屏从聊天菜单打开抽屉。侧栏无需配置模型即可使用，笔记数据与独立页面共用。用户 ID 由宿主会话或 Agent RequestContext 提供，不能通过请求体选择其他用户。

## 保留源码但完全不加载

在插件的 `plugin.manifest.json` 中设置：

```json
{ "enabled": false }
```

这是清单的一个字段，保留其余必需字段。省略时默认 `true`；只接受布尔值，不接受字符串 `"false"`。

| 设置                        | 作用                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 清单 `enabled: false`       | 发现阶段排除插件，不生成前后端模块导入、数据库实体/迁移入口、页面/侧栏入口或插件样式扫描入口，也不打包其 Skill；后台列表不会出现该插件 |
| 清单 `enabled: true` 或省略 | 插件参与构建、迁移和注册；初次安装在后台仍然默认停用                                                                                   |
| 后台启用/停用               | 控制已加载插件的能力是否可用，状态保存在数据库，与清单的构建开关独立                                                                   |

修改后，开发环境重启 `pnpm dev`；生产环境重新执行 `pnpm build` 并重启服务，前后端使用同一份新产物。仅修改清单或运行 `plugins:generate` 不会改变正在运行的服务或旧的 `dist`。Docker 需重新构建并部署镜像。

排除插件不会执行它的新迁移，也不会删除已有数据表、安装记录或数据；新进程同步 Skill 时会清理上次发布留下的插件 Skill 副本。以后改回 `true` 并重新发布，后台启停状态会沿用数据库中保存的选择。其他已选择插件依赖被排除的插件时，发现命令会报 `Disabled plugin dependency`；不会隐式加载它。

发现阶段仍读取并校验清单，但不检查或导入被排除插件的代码入口。这个开关不裁剪 pnpm workspace 依赖安装或 Docker 中保留的仓库源码；宿主也不应直接导入被排除插件的内部模块。

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
  "apiVersion": 2,
  "enabled": false,
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
- `apiVersion`：当前为 `2`，不兼容版本在发现阶段失败。
- `enabled`：源码发现开关，默认 `true`；`false` 完全排除该插件，不进入后台管理。与后台持久化启停状态独立。
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
  // context.assertEnabled  异步检查持久化选择、当前实例及依赖是否就绪
  return { api, agents, tools };
}
```

- `api`：`Hono<PluginHttpEnv>`，自动挂载到 `/api/plugins/<id>`。宿主统一处理会话、写操作 Origin 校验、128 KiB 请求体限制、启停检查和错误脱敏。
- `c.get('userId')`：当前会话用户 ID；`c.get('isAdmin')`：管理员标志。插件必须自行校验记录归属、项目成员关系和业务操作权限。**页面的 `admin` 标志不替代 API 权限检查。**
- `agents`：宿主 `BaseAgent[]`，ID 使用 `plugin:<id>:<name>`；`source: 'code'`；`model: null` 继承宿主模型配置；`agents: {}` 默认不委派。宿主 AgentService 统一列出和执行，不需要写入 Mastra Agent 数据表。
- `tools`：继承 `@app/plugin-sdk/tools` 中 `PluginTool` 的类实例数组，与内置工具共享 `BaseTool`，通过 `getTools(config, dependencies, options)` 返回 Mastra 工具数组。ID 使用 `plugin_<id（连字符转下划线）>_<name>`。宿主包装执行入口，因此已经取出的句柄在停用后也无法执行。工具进入全局配置、Agent 和 `exec` 目录，支持标准启停开关；结果使用现有通用工具展示。本版未增加任意工具配置表单或专用结果渲染器注册接口。
- `onEnable`：可选的同步或异步启用回调，用于启动定时任务、订阅和连接。后台开启、服务启动恢复，以及其他实例开启后的状态同步都会触发；宿主等待成功后才开放当前实例的能力。
- `onDisable`：可选的同步或异步停用回调，用于停止并等待后台任务结束、取消订阅、关闭插件自己的连接。后台关闭、其他实例关闭后的状态同步、服务退出以及 `onEnable` 部分失败后的补偿清理都会触发。
- `dispose`：可选的异步进程退出清理函数。在 `onDisable` 之后执行；即使前面的清理失败，宿主仍会尝试所有插件的 `dispose`，等待全部结束后再关闭共享数据库。

每个插件工具定义自己的类，构造函数传入 Mastra 工具定义，业务依赖由插件注入。例如：

```ts
import { PluginTool } from '@app/plugin-sdk/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

class ListNotesTool extends PluginTool {
  constructor(listNotes: (userId: string) => Promise<unknown[]>) {
    const tool = createTool({
      id: 'plugin_notebook_list_notes',
      description: '查询当前用户的笔记',
      inputSchema: z.object({}),
      execute: async (_input, context) => {
        const userId = context?.requestContext?.get('userId');
        if (typeof userId !== 'string' || !userId)
          throw new Error('UNAUTHORIZED');
        return { notes: await listNotes(userId) };
      },
    });
    super(tool);
  }
}

// createServer 返回：tools: [new ListNotesTool(listNotes)]
```

`getTools` 统一处理配置、`ids`、`disabledTools` 和 Agent 限制。`onlyAgents: false`（默认）允许所有 Agent；传入 ID 数组时，只允许对应 Agent 使用，并在执行时再次检查。`dependencies.agentId` 提供构建时 Agent，执行上下文中的 Agent 优先。`onlyPlugins` 暂未开放。插件 API v2 不再接受直接返回 `createTool()` 实例，需要改成上述子类。

`createServer` 只构造接口，不能启动后台任务或外部副作用。参与构建的插件即使在后台停用也会调用它；清单 `enabled: false` 的插件不会导入或调用此入口。生命周期函数可以直接闭包使用 `context`，不需要重新创建插件实例：

```ts
export default function createServer(context: PluginContext): PluginServer {
  let controller: AbortController | undefined;
  let task: Promise<void> | undefined;
  return {
    async onEnable() {
      if (task) return;
      controller = new AbortController();
      // 初始化失败时抛错；后台循环内部处理错误，并在每次业务执行前调用
      // context.assertEnabled()。runWorker 应响应 signal，取消后正常结束。
      await prepareResources();
      task = runWorker(context, controller.signal);
    },
    async onDisable() {
      controller?.abort();
      try {
        await task;
      } finally {
        task = undefined;
        controller = undefined;
        // 也必须能清理 prepareResources 部分成功后留下的资源。
        await releaseResources();
      }
    },
  };
}
```

上述 `prepareResources`、`runWorker`、`releaseResources` 由具体插件实现。后台循环必须处理自身的异常，不能留下未处理的 Promise rejection；`context.assertEnabled()` 在 `onEnable` 完成且启用选择写入数据库前不会通过，不要在初始化回调中依赖它。

### 生命周期与失败语义

- 开启时先执行 `onEnable`，成功后才保存开启状态；失败会调用 `onDisable` 回收部分资源，原先关闭的数据库状态保持关闭。数据库写入失败也会清理本次启动的资源。
- 关闭时先保存关闭状态，使所有实例的新请求立即被拒绝，再执行当前实例的 `onDisable`。清理失败返回 `PLUGIN_DISABLE_FAILED`，但保持关闭，不会把已部分清理的插件重新标为启用。宿主保留清理标记，后续同步和退出时重试；旧资源清理成功前不会再次调用 `onEnable`。
- 服务启动时按依赖顺序恢复数据库中已开启的插件。某插件恢复失败时保留开启选择，当前实例的插件及其依赖者不可用；其他插件仍可运行，后续同步会重试恢复。
- 服务正常退出时按依赖的逆序执行各插件的 `onDisable`、`dispose`，不修改数据库中的启用选择。重复启动、关闭请求不会重复分配资源；退出会等待正在进行的生命周期操作，并拒绝后续开启操作。
- 多实例共享数据库选择，每个进程维护自己的资源，默认每 2 秒同步一次。同步耗时还取决于回调时间及锁等待；关闭后新请求立即拒绝，其他实例的后台资源在同步时释放。`updated_at` 用于识别两次同步之间的关闭再开启，届时会重建资源和依赖者。生命周期不是集群单例任务调度器；只允许执行一次的业务需自行使用分布式锁。
- 所有回调必须可重试，并在有限时间内完成；`onDisable` 必须能处理未完全初始化的资源。资源清理失败后，宿主只能阻止新访问并继续尝试清理，无法替代插件撤销任意外部副作用。强制终止进程时无法保证执行回调。

`PluginStatus.desiredEnabled` 是保存的启用选择，后台 Switch 使用该字段；`enabled` 表示当前实例及其依赖实际可用，控制 Badge、入口和权限检查。恢复中或恢复失败时两者可能不同，`reason` 显示原因。开关请求失败时响应也包含可读取到的最新 `plugin` 状态，前端只更新对应条目。

插件使用宿主 DataSource，不能自行关闭、初始化或开启 `synchronize`。普通共享类型可从 `@aime/shared` 导入；插件可在同仓库引用源项目模块，但内部路径不承诺兼容性。稳定入口优先使用 SDK，业务页面与逻辑继续放在插件自己的模块目录。

### 界面参数与生命周期参数

在 `plugin.manifest.json` 中声明 `configFields`，后台会出现「参数配置」按钮。省略时默认为空数组：

```json
{
  "configFields": [
    {
      "key": "endpoint",
      "label": "服务地址",
      "type": "text",
      "required": true
    },
    {
      "key": "token",
      "label": "访问密钥",
      "type": "password",
      "required": true
    },
    {
      "key": "intervalSeconds",
      "label": "同步间隔（秒）",
      "type": "number",
      "integer": true,
      "min": 1,
      "max": 3600,
      "default": 60
    },
    { "key": "debug", "label": "调试模式", "type": "boolean", "default": false }
  ]
}
```

字段支持 `text`（可用 `multiline: true`）、`password`、`number`、`boolean`、`select`，最多 50 个。`key` 必须唯一，以英文字母开头，只包含字母、数字、下划线。公共选项有 `description`、`required`、`group`；文本/密码支持 `placeholder`；数字支持 `min`、`max`、`integer`。密码使用宿主 `PasswordInput`，禁止在清单中设置密码默认值。其他类型可设 `default`，布尔值默认 `false`。前后端均校验类型、必填项和数值范围，拒绝未知字段。

`group` 是表单 Tab 标题，按首次出现的顺序展示，未设置时兼容原平铺表单。切换 Tab 保留草稿，提交时校验全部参数并切换到首个错误所在 Tab。`select` 必须声明 `options: [{ "value": "tdx", "label": "通达信" }]`，默认值必须在选项内。字段可声明 `visibleWhen: { "field": "engine", "equals": "tdx" }`，控制字段须为无条件的 text/select/boolean；隐藏时暂不要求必填，已有值仍保留，切换选项不会清空账号。

### 运行环境与专属空间

服务端 `createServer(context)` 可读取 `context.runtime.platform`、`arch`、`nodeVersion` 和 `paths`：

- `applicationRoot`：宿主安装根目录。
- `workspaceRoot`：宿主实际解析的 `WORKSPACE_ROOT`，不依赖插件当前工作目录。
- `pluginRoot`：插件安装目录 `<applicationRoot>/plugins/<pluginId>`，用于读取随包资源。
- `pluginWorkspace`：插件声明 `"workspace": true` 时为 `<workspaceRoot>/plugins/<pluginId>`；未声明则为 `null`。

在插件清单中设置 `"workspace": true`，然后在需要写入时调用 `await context.runtime.ensureWorkspace()`。该方法幂等创建并返回专属目录，拒绝逃逸目录的符号链接；构造插件时不自动写磁盘。停用或构建排除保留数据，其他插件使用各自目录。这是可信插件的路径约定，不是进程安全沙箱。

Vibe Quant 使用此目录的 `.venv` 管理 Python 依赖，不再将机器路径作为用户参数。资源路径来自 `pluginRoot`，持久化路径来自 `pluginWorkspace`。

生命周期通过第一个参数的 `config` 接收验证过的配置，类型为 `Readonly<Record<string, string | number | boolean>>`：

```ts
export default function createServer(context: PluginContext): PluginServer {
  return {
    async onEnable({ config }) {
      await startSync({
        endpoint: config.endpoint as string,
        token: config.token as string,
        intervalSeconds: config.intervalSeconds as number,
        debug: config.debug as boolean,
      });
    },
    async onDisable({ config }) {
      // 对应本次启动的旧参数，而不是后台刚保存的新参数。
      await stopSync(config.endpoint as string);
    },
  };
}
```

`startSync`、`stopSync` 由插件实现。每次激活都有独立、不可修改的参数快照；停用、启动失败补偿、清理重试和退出都使用对应激活的原始快照。未声明参数的插件收到 `{ config: {} }`，原来的无参数回调仍兼容。

参数保存到 `plugin_installations.config`，重启和其他实例恢复时使用保存值。停用插件保存参数不会启动插件；运行中保存参数会先逆序停止插件及依赖者，再按依赖顺序启动，`onDisable` 收到旧值，`onEnable` 收到新值。相同已保存参数不会重复启动。保存成功但回调失败时返回 `applied: false`，新参数仍保留，界面提示并允许修正，宿主继续重试恢复。

只有管理员可以读取、修改参数值；公共插件列表不含参数值。读取时取得 `revision`，保存时必须带回；参数或启用状态已被其他操作修改时返回 `PLUGIN_CONFIG_CONFLICT`，避免覆盖更新。新增/修改字段定义需重新生成、构建及重启；已有参数不满足新定义时不会启动，管理员可在弹窗中修正。首次发布此功能需运行 `pnpm db:migrate`。

Demo 的 `maxNotes` 参数控制单次返回笔记数（1–50）；其构建排除开关保持不变。

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

启动时收集参与构建的插件实体，但页面/API/AI 能力仅对版本和迁移就绪的已启用插件开放。清单 `enabled: false` 的插件不进入实体或迁移集合。代码版本与安装版本不一致时不允许启用。停用不会删除表、笔记或工具配置；本版不提供卸载删表和自动数据库降级。

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

每个插件可以在自己的 `package.json` 声明 npm 依赖和组件库。React 与 React DOM 使用 `peerDependencies`，宿主 Vite 对 React、React DOM、Router 去重。参与构建的插件样式通过 `generated.css` 纳入 Tailwind 扫描，其他组件库样式应在插件入口导入并避免全局 reset。Node 原生扩展及系统库仍需在 Docker 构建阶段提供。本版不支持后台上传源码后即时安装依赖。

### 插件聊天线程

在清单中设置 `"chatThreads": { "agentId": "plugin:<id>:<agent-id>" }`，宿主会在应用左侧该插件分组下显示可折叠的聊天区域。`agentId` 可省略以使用宿主默认 Agent；未声明 `chatThreads` 的插件不显示此区域。入口随插件启停，管理导航中不重复显示。

区域按 `thread.plugin === plugin.id` 精确筛选当前用户的未归档个人线程，支持分页、实时状态、切换、重命名和归档。新建会保存插件 ID 并打开聊天，但不会自动发送消息。普通个人聊天和项目聊天列表默认排除带 `plugin` 的线程，项目运行数量也只统计普通线程。列表 API 未传 `plugin` 时排除插件线程，传入时按插件 ID 精确筛选；与 `projectId` 同时使用时只筛选该授权项目，筛选发生在分页之前。

插件页面也可以从 `@app/plugin-ui` 导入共用组件：

```tsx
import { ThreadSidebar } from '@app/plugin-ui';

<ThreadSidebar plugin={pluginId} agentId="plugin:vibe-quant:quant-agent" />;
```

`ThreadSidebar` 包含折叠、新建、路由切换和编辑弹窗。只需要列表时可使用 `ThreadList`，传入 `plugin`、`selectedId`、`onSelect` 和 `onAction`；需要自定义数据源时可传入 `resource`。两者复用宿主会话内的实时导航与分页缓存；默认跟随外层 `ScrollArea` 滚动，独立选择器可给 `ThreadList` 传入 `maxHeight`。

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

启停写入数据库后，新 API 请求、新 Agent 解析和每次插件 Tool 执行立即重新检查；启用还要求当前实例的生命周期已就绪。已开始执行的请求不会被宿主主动取消，插件的 `onDisable` 应协调正在使用其资源的操作并等待它们结束。页面开关立即更新当前导航，其他浏览器在窗口聚焦或最多约 15 秒的可见页面轮询后同步；前端检查不作为权限边界。停用不卸载已经加载的 JavaScript。

可信插件可以执行任意宿主进程代码；这是一套扩展接口，不是第三方代码沙箱。

## API 一览

参数 API：管理员使用 `GET /api/plugins/:id/config` 读取 `{ config, revision }`，使用同源 `PUT /api/plugins/:id/config` 提交同样结构，返回 `{ plugin, configuration, applied }`。停用时仍可读写。参数无效返回 `PLUGIN_CONFIG_INVALID`（400，含字段 `issues`）；版本冲突返回 `PLUGIN_CONFIG_CONFLICT`（409）。这两个配置路径由宿主保留。

| 方法   | 路径                              | 权限 / 行为                                                           |
| ------ | --------------------------------- | --------------------------------------------------------------------- |
| GET    | `/api/plugins`                    | 登录；管理员看到全部插件，普通用户只看到启用插件                      |
| PUT    | `/api/plugins/:id/enabled`        | 管理员、同源；请求体 `{ "enabled": true }`，返回更新后的 PluginStatus |
| GET    | `/api/plugins/notebook/notes`     | 登录且插件启用；最新 50 条个人笔记                                    |
| POST   | `/api/plugins/notebook/notes`     | 登录且插件启用；`{ "title": "...", "content": "..." }`                |
| DELETE | `/api/plugins/notebook/notes/:id` | 登录且插件启用；只能删除自己的笔记                                    |

宿主保留插件 API 下的 `PUT /enabled`。常见错误码：`UNAUTHORIZED`（401）、`FORBIDDEN`（403）、`PLUGIN_DISABLED`（404）、`PLUGIN_NOT_FOUND`（404）、`PLUGIN_MIGRATION_REQUIRED`、`PLUGIN_DEPENDENCY_DISABLED`、`PLUGIN_HAS_DEPENDENTS`、`PLUGIN_ENABLE_FAILED`、`PLUGIN_DISABLE_FAILED`（409）、`PLUGIN_SERVICE_STOPPING`（503）。

## 构建、发布与验证

```sh
pnpm plugins:generate          # 校验清单，生成前后端注册入口及 Skill 资源
pnpm build                     # 自动发现 + 服务端产物 + 前端插件异步 chunk
pnpm db:migrate                # 迁移到本次发布版本
pnpm start                     # 加载已经发布的插件代码
pnpm test:plugins              # 不访问数据库的发现和生命周期单元测试，集成测试默认跳过
pnpm test:plugins:integration  # 使用 .env 的 PostgreSQL 凭证创建临时测试库，结束后删除
```

集成测试要求数据库用户具有 `CREATEDB` 权限，只在临时数据库中操作。覆盖迁移幂等与回滚、API 权限及用户隔离、持久化启停、依赖关系、Agent 调用真实插件 Tool、`exec` 调用、旧句柄拒绝及 Skill 发现。发现测试覆盖清单排除、依赖拒绝、注册入口与旧 Skill 清理；集成测试显式加载 Demo 测试夹具，不受 Demo 清单开关影响，也不会修改实际清单。Agent 流程使用确定性模拟模型，不等于真实供应商推理验收。

生命周期测试还覆盖部分启动失败的补偿、清理失败重试、并发幂等、数据库写入失败、多实例同步与资源重建、重启恢复，以及退出与正在执行的回调之间的竞态。

Dockerfile 已在构建阶段执行 `pnpm build` 并复制完整仓库，插件包、依赖和 Skill 资源会随镜像发布；服务端入口继续执行 `pnpm db:migrate`。前后端应发布同一份提交。插件生成文件可提交，但必须通过生成命令更新，不手工编辑。
