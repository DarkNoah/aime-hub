# 个人聊天

本文件说明 `/threads` 与 `/threads/:threadId` 的个人聊天能力。项目模块已复用同一套 ThreadService 与 ChatPanel，范围和权限见 `./projects.md`。

## 组件与目录

- `apps/web/src/components/chat/`：完整、可嵌入的 `ChatPanel`，包括消息、推理过程、工具结果、图片、模型设置、输入、队列、运行状态和历史分页。通信 Hook 与 transport 同目录组织，无 React Router、页面高度或定位依赖。
- `apps/web/src/pages/threads/`：页面路由适配、侧栏聊天折叠列表、会话共享状态、重命名／删除 Dialog。列表每页 10 条，向下滚动自动加载；更新单项保留分页与滚动位置，页面不再单独显示一列列表。
- `apps/server/src/modules/threads/`：权限、HTTP/SSE、运行队列、动态 Agent 工厂、工作目录与 skills 发现。
- `apps/server/src/modules/models/language-model.ts`：个人模型配置、统一模型解析和供应商思考参数转换。
- `apps/server/src/mastra/storage.ts`：Mastra PostgreSQL 存储与历史查询用 Memory 配置。
- `apps/server/src/mastra/index.ts`：参照 `ui-dojo/src/mastra/index.ts` 集中创建 Mastra 实例，注册系统 Agent、Workflow 和共享存储；由服务启动入口创建一次，通过依赖注入供动态聊天 Agent 使用。HTTP/SSE 仍由业务路由提供，不启用 Mastra apiRoutes。
- `apps/server/src/mastra/agents/`：保留给系统固化的 Agent 定义。按用户、线程和模型创建运行实例的工厂放在 `modules/threads/runner.ts`。

页面和悬浮容器使用相同组件。宿主需要已有的 i18n、`SessionProvider`、`AvailableModelsProvider` 和 Sonner `Toaster`，为容器指定高度即可：

```tsx
import { ChatPanel } from '@/components/chat';

<div className="h-[620px] w-[420px] max-w-full overflow-hidden rounded-xl border">
  <ChatPanel
    threadId={selectedThreadId}
    onThreadCreated={(thread) => setSelectedThreadId(thread.id)}
    onThreadUpdated={updateThreadListItem}
    onClose={closeWindow}
  />
</div>;
```

`threadId` 不传时显示新聊天，并在首次发送成功后自动切换到新线程；宿主可以通过 `onThreadCreated` 保存 ID。组件关闭／卸载只断开订阅，不停止服务端运行。只有「停止」才调用 abort。`headerActions` 可插入宿主自己的按钮，定位、拖拽、缩放由宿主负责。

模型与思考控制位于附件按钮旁。选择模型即时保存个人默认配置；思考按钮打开 Popover，通过离散 Slider 选择等级，拖动时预览、松开后保存，支持键盘调节。新聊天和已有聊天均读取当前个人默认配置；选择「系统默认模型」会清除个人模型覆盖。写入按顺序执行，失败恢复至最近成功保存的值并显示 toast。`ChatPanel` 自带设置 Provider；同一宿主挂载多个面板时可在外层共用 `PersonalChatSettingsProvider`，使所有面板同步选择。消息不显示角色署名，复制操作使用带无障碍标签的图标按钮。

只有消息列表最后一条消息展示思考，并只展示该消息最后一段 reasoning；此前消息的正文、附件与工具结果继续显示。该段流式输出时默认展开，完成后收起，可手动展开。流式期间手动折叠后，后续文本增量不会重置展开状态；开始新的一段思考或恢复流式时重新默认展开。

## 数据与运行

线程及消息使用 Mastra 原生存储，资源归属为 `user:<userId>`。每个查询、订阅与变更均检查当前登录用户，普通用户只能获取不含凭据的模型目录。写接口校验 Origin；创建线程和发送消息不接受客户端指定 resourceId 或工作路径。

Mastra 使用现有 PostgreSQL 中独立的 `mastra` schema，由官方 `PostgresStore.init()` 初始化。业务偏好使用现有 TypeORM `settings` 表，键为 `chat:user:<userId>`。不会新增自定义线程或消息表。

模型优先级为当前消息／线程选择、个人默认、系统默认。系统默认由供应商管理页面配置；`.env` 中预留的 `OPENAI_API_KEY`／`DEFAULT_MODEL` 不作为绕过供应商管理的隐式连接。供应商凭据只在服务端解析，模型 ID 含斜杠时保留完整后缀。

每轮 Agent 开启 thread scope 的 Observational Memory，使用本轮解析出的模型。支持工具调用的模型接入受目录边界约束的 Mastra Workspace 和 filesystem path skills。工作目录为 `WORKSPACE_ROOT/users/<userId>/<yyyy-MM-dd>-<nanoid(6)>`，日期使用 Asia/Shanghai。全局与个人 `.agents/skills` 递归发现 `SKILL.md`，按包目录名作为 skill ID、相对父目录作为分组；个人同名包覆盖全局包。

HTTP 仅提交新消息，AI SDK `useChat` 的 transport 收到接受响应后即可再次发送；独立 SSE 订阅负责更新消息。首次订阅发送缓存快照，之后只推送变化消息及线程状态，流式更新最多每 50ms 合并发送。重连刷新最新历史窗口后叠加实时消息，历史分页使用固定时间上界，避免后续新增消息导致分页移动。

每个线程串行执行，消息 ID 支持重试去重。空闲时提交的消息直接保存并运行，不进入队列；已有任务执行时，新消息才排队。若停止后仍有暂停的排队消息，空闲时新提交的消息先直接运行，再继续剩余队列。队列最多 20 条且总序列化大小不超过 16 MiB；输入支持文字和最多 4 张图片，每张不超过 2 MiB。队列与近期已接受 ID 存在 Mastra thread metadata 中。立即消息通过 `prepareStep` 在当前工具调用完成后的下一步注入；若当前轮没有后续步骤，则紧接当前轮运行。停止会保留部分回复并暂停剩余队列，可继续或移除排队消息。

输入框不再提供发送模式下拉框，新消息默认按排队方式提交，空闲线程仍直接运行。待发消息以紧贴输入框上沿的窄条列表展示，支持拖动手柄排序、方向键或菜单上移／下移、删除，以及通过 shadcn Toggle 切换「立即」。选中「立即」时在当前轮下一步注入，未选中则按队列顺序运行。点击消息或菜单编辑会打开 Dialog，读取完整文字，修改时保留图片附件、作者与模型设置。队列变更通过同一线程锁持久化并以 SSE 同步，已开始执行或已移除的消息拒绝修改；暂停队列的编辑不会自动恢复运行。

## 全局线程导航

登录后的布局维护一条 `GET /api/threads/events` SSE，覆盖个人线程和有权限访问的全部项目线程。首次连接及重连发送线程摘要、项目摘要快照，后续按线程推送新增、修改、删除和运行状态；不会传输消息历史和回复正文，也不会随回复 token 重复广播未变化的摘要。

侧栏和项目页共用会话内缓存，分页继续控制可见条数；实时更新不重置已加载页数。完整摘要用于统计每个项目正在执行的线程数，包含正在停止但执行器尚未退出的线程，不计暂停队列。项目折叠或未打开时也继续维护计数。HTTP 应答与当前聊天的消息 SSE 不覆盖全局订阅中较新的摘要。断线重连校准离线期间的新增、删除和权限变化，退出登录销毁订阅与缓存。

项目成员权限在推送前复查，项目或成员变更刷新相关会话的导航；慢连接及内部故障关闭连接后由客户端重连。全量摘要初始化适用于当前单实例部署；线程规模增长后需改为摘要索引和可恢复的增量游标，避免每次重连读取全部摘要。

## 接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/threads/events` | 全局导航 SSE：navigation（snapshot/upsert/remove/project-removed）、expired |
| `GET /api/threads?page=0` | 个人会话分页，每页 10 条 |
| `POST /api/threads` | 创建个人会话 |
| `GET /api/threads/:id` | 会话状态与缓存消息 |
| `PATCH /api/threads/:id` | 标题／模型配置 |
| `DELETE /api/threads/:id` | 删除空闲且无队列的会话，保留工作文件 |
| `GET /api/threads/:id/history?page=0&anchor=...` | 消息分页 |
| `GET /api/threads/:id/messages` | SSE：snapshot、update、expired |
| `POST /api/threads/:id/messages` | 接受新消息，返回 202 |
| `POST /api/threads/:id/abort` | 停止当前轮并暂停队列 |
| `POST /api/threads/:id/resume` | 继续队列 |
| `GET /api/threads/:id/queue/:messageId` | 获取待发消息完整文字与附件存在标记 |
| `PATCH /api/threads/:id/queue/:messageId` | 修改待发文字或立即标记 |
| `PATCH /api/threads/:id/queue` | 将指定待发消息移到另一条之前，beforeId 为 null 时移到末尾 |
| `DELETE /api/threads/:id/queue/:messageId` | 移除排队消息 |
| `GET /api/threads/preferences` | 获取个人默认配置 |
| `PUT /api/threads/preferences` | 保存个人默认配置 |

## 验证与部署边界

- `scripts/thread-navigation.test.ts`：后台运行状态、项目权限隔离与撤销、摘要去重、连接初始化事件顺序、重连校准、完整运行数、分页保留及真实 HTTP/SSE 广播。使用内存存储与确定性执行器。
- `scripts/threads.test.ts`：归属权限、每页 10 条、列表并发请求合并与增量更新、分页重试、并发串行化、断开订阅不停止、重复提交、立即／排队、暂停恢复、进程重启提示、固定历史分页、附件验证、历史合并和 skills 覆盖。
- `scripts/thread-queue.test.ts`：完整文字编辑与附件保留、立即标记切换、排序后的实际执行顺序、并发新增保留、权限、过期消息拒绝、保存失败回滚、暂停与重启持久化，以及 HTTP 接口校验。
- `scripts/chat-preferences.test.ts`：共享默认配置读取、连续修改按序保存、失败恢复与重试、会话退出取消待发写入。
- `scripts/threads.integration.test.ts`：真实 PostgreSQL、Mastra Memory、Agent、HTTP/SSE 与本机 OpenAI 兼容测试服务；包含持久化 ID 一致性、停止保存部分回复、队列恢复、Workspace 工具调用后的立即注入。需要 `TEST_DATABASE_URL`，只创建并清理随机命名的测试 schema。
- 浏览器验证使用隔离测试服务，已覆盖实际页面的发送、多轮、刷新，以及 390px 窄屏与独立 420×620 容器中的排队、停止、继续。侧栏验证了 10→20→23 条自动分页、折叠展开、重命名保留滚动位置及移动导航选中后收起。没有调用真实供应商；真实模型的思考等级、图片理解和长上下文触发 OM 仍需配置对应供应商后验收。

当前运行队列由一个服务进程持有，部署时使用单实例。页面关闭不会中断运行；进程重启不能继续原模型连接，会提示中断，保留已写入消息与队列供用户继续。多实例需要共享执行锁和事件通道后再启用。反向代理需关闭 SSE 缓冲并允许长连接。
