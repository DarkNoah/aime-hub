# 个人聊天

本文件说明 `/threads` 与 `/threads/:threadId` 的个人聊天能力。项目模块已复用同一套 ThreadService 与 ChatPanel，范围和权限见 `./projects.md`。

## 组件与目录

- `apps/web/src/components/chat/`：完整、可嵌入的 `ChatPanel`，包括消息、推理过程、工具结果、图片、模型设置、输入、队列、运行状态和历史分页。通信 Hook 与 API 同目录组织，无 React Router、页面高度或定位依赖。
- `apps/web/src/pages/threads/`：页面路由适配、侧栏聊天折叠列表、会话共享状态、重命名／删除 Dialog。列表每页 10 条，向下滚动自动加载；更新单项保留分页与滚动位置，页面不再单独显示一列列表。
- `apps/server/src/modules/threads/`：权限、HTTP/SSE、原生队列接入、动态 Agent 工厂、工作目录与 skills 发现。
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

每个线程的 Agent session 开启 thread scope 的 Observational Memory，使用创建 session 时解析的模型；每轮对话模型按输入设置选择。支持工具调用的模型接入受目录边界约束的 Mastra Workspace 和 filesystem path skills。工作目录为 `WORKSPACE_ROOT/users/<userId>/<yyyy-MM-dd>-<nanoid(6)>`，日期使用 Asia/Shanghai。全局与个人 `.agents/skills` 递归发现 `SKILL.md`，按包目录名作为 skill ID、相对父目录作为分组；个人同名包覆盖全局包。

输入框以 `/` 开头时显示通用快捷命令菜单，技能统一位于“技能”分类下，再按相对父目录（如 `test`、`owner/repo`）分组。根目录技能直接显示在分类下；技能名和描述同一行展示，不使用图标。输入可过滤名称、描述和目录分组，方向键选择，Enter / Tab 或点击补全命令，保留后续文字。扫描遇到 `SKILL.md` 即视为技能包并停止向包内递归；ID 与命令名统一取包目录名，即使 frontmatter 的 `name` 不一致也会显示。目录列表与运行时共享同一读取适配层，仅在内存中规范技能名称，保留描述、正文和资源文件，不改写原始 `SKILL.md`；其他元数据继续使用 Mastra 校验。

HTTP 仅提交新消息，收到接受响应后即可再次发送；服务端通过 `agent.subscribeToThread()` 观察所有原生运行，再由独立 SSE 订阅更新界面。首次订阅发送缓存快照，之后只推送变化消息及线程状态，流式更新最多每 50ms 合并发送。重连刷新最新历史窗口后叠加实时消息，历史分页使用固定时间上界，避免后续新增消息导致分页移动。

普通消息直接调用 Mastra `queueMessage(message, target)`，空闲时唤醒运行，忙碌时按 FIFO 等待下一轮。即时输入调用 `sendMessage(message, target)`，由 Mastra 在后续步骤处理。两者都使用 `ifIdle.streamOptions.untilIdle: true`；工具恢复使用 `resumeStreamUntilIdle()`，后台任务完成后的续跑由 Mastra 处理。应用不再保存新消息的队列数组，也不自行取出或注入下一轮消息。

消息 ID 支持提交去重。原生 user signal 的 metadata 保存客户端消息 ID、作者和设置，历史与实时订阅都映射到同一用户消息 ID。输入支持文字和最多 4 张图片，每张不超过 2 MiB。服务端 `prepareStep` 只读取已消费 signal 的模型设置，不提取应用队列。

输入框默认使用 FIFO 提交。队列区显示 `subscribeThreadEvents()` 的待处理数量，并保留编辑、拖动排序、即时切换、逐条取消和清空。`PendingInputs` 仅缓存已提交的 signal ID 与输入内容作为展示副本，不持久化执行队列、不启动或取出下一轮。编辑／排序通过 `cancelQueuedMessages({ signalIds })` 取消受影响的后缀，只对 `cancelledSignalIds` 中确认取消成功的输入调用 `queueMessage()`／`sendMessage()` 重新提交。若目标或排序锚点已进入执行，则恢复其他已取消项的原顺序并返回冲突，绝不重复提交已执行项。重入队失败的内容显示为“未提交”草稿，需用户显式重试。取消后重入队不是原子重排，目前按单进程部署；不把本地取消回执当作跨进程确认。清空调用 `cancelQueuedMessages()`，保留当前回复；停止调用 `abortThreadStream({ clearPendingSignals: true })`，终止当前运行并清空待处理消息。审批或补充输入通过原工具交互恢复，等待期间拒绝新的普通输入。

升级前 thread metadata 中的旧队列，在下次创建原生 session 时逐条交给官方队列，成功接收后移除旧草稿。新的待处理消息只保存在 Mastra 当前进程队列中，进程重启后不恢复；已消费并持久化的消息、线程与工具交互仍可读取。

## 目标模式

输入 `/goal` 或在快捷命令中选择它会立即开启目标模式，不发送聊天消息。输入框下方工具栏显示目标 Badge，仅包含左侧关闭按钮和「目标」／「Goal」标签，下一条文字消息作为目标；只有图片的消息不能创建目标。新聊天和项目聊天使用同一入口，技能列表加载失败不影响内置命令。

目标通过 Mastra `Agent.setObjective()` 持久化到 thread state，评估模型复用当前聊天模型，默认最多评估 50 次。新目标使用即时输入进入当前轮；后续消息继续围绕原目标，重复请求不会重置评估预算。Mastra 原生目标循环负责续跑、完成、等待用户及预算耗尽／评估失败暂停，应用不另建执行循环。聊天快照与 SSE 返回 `goal`，界面仅显示目标 Badge，重新打开聊天时从原生存储恢复目标。

点击 Badge 上的关闭按钮会清除目标。目标仍处于 active 状态时，关闭同时停止当前执行并清空待处理输入；服务端等待当前流结束后清除目标，防止正在运行的评估把目标重新写回。关闭已完成或已暂停目标不会停止普通回复。尚未发送的目标模式只属于当前输入草稿；已经提交的目标跨页面刷新保留，进程重启后在下一条消息时继续评估。

## 全局线程导航

登录后的布局维护一条 `GET /api/threads/events` SSE，覆盖个人线程和有权限访问的全部项目线程。首次连接及重连发送线程摘要、项目摘要快照，后续按线程推送新增、修改、删除和运行状态；不会传输消息历史和回复正文，也不会随回复 token 重复广播未变化的摘要。

侧栏和项目页共用会话内缓存，分页继续控制可见条数；实时更新不重置已加载页数。完整摘要用于统计每个项目正在执行的线程数，依据原生运行状态统计，不把待处理数量当作运行数量。项目折叠或未打开时也继续维护计数。HTTP 应答与当前聊天的消息 SSE 不覆盖全局订阅中较新的摘要。断线重连校准离线期间的新增、删除和权限变化，退出登录销毁订阅与缓存。

项目成员权限在推送前复查，项目或成员变更刷新相关会话的导航；慢连接及内部故障关闭连接后由客户端重连。全量摘要初始化适用于当前单实例部署；线程规模增长后需改为摘要索引和可恢复的增量游标，避免每次重连读取全部摘要。

## 后台任务数据

每个线程 runtime 持有一个 `backgroundTaskManager.stream({ threadId, resourceId, abortSignal })` 订阅，使用服务端确认的 `user:<userId>` 或 `project:<projectId>` 归属。`GET /api/threads/:id` 和消息 SSE 的 snapshot/update 返回 `backgroundTasks`；前端通过 `useThreadChat().backgroundTasks` 读取。任务明细不进入全局导航摘要。

任务记录由 Mastra 原生任务存储持久化，runtime 缓存活动任务和最近最多 100 条结束任务，不重复写入线程 metadata。初始化和订阅重连时从存储补齐，事件更新按任务 ID 合并；`background-task-started` 额外补齐尚在排队的任务。状态保留 `pending/running/suspended/completed/failed/cancelled/timed_out`，输出只保留最新一块 `lastOutput`，订阅故障通过 `backgroundTasksError` 报告。

ChatPanel 标题旁用图标与数量显示当前线程的运行中任务，点击展开紧凑列表，每项可手动停止；归零时隐藏入口。`POST /api/threads/:id/background-tasks/:taskId/cancel` 校验线程访问权限及任务的 threadId/resourceId 后调用 Mastra `cancel(taskId)`，已结束任务重复停止为幂等操作。取消后的状态通过同一 SSE 更新，不刷新整个会话。

浏览器断开、停止当前 Agent 轮次都不关闭 runtime 的任务订阅；订阅在 runtime 过期、线程／项目删除或服务关闭时释放。排队、运行中的任务阻止 runtime 过期；有活动任务时拒绝删除线程／项目。关闭订阅仅停止监听，不会取消任务。前台工具不产生这条流的后台生命周期事件，后台任务状态也不直接替代会话的运行状态。该订阅只负责展示，不再通过任务完成回调创建应用续跑队列。

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
| `POST /api/threads/:id/abort` | 停止当前轮并清空待处理消息 |
| `POST /api/threads/:id/retry` | 使用已有历史重试失败运行 |
| `DELETE /api/threads/:id/goal` | 关闭目标模式；活动目标同时停止当前执行 |
| `DELETE /api/threads/:id/queue` | 清空官方待处理队列，保留当前运行 |
| `GET /api/threads/:id/queue/:messageId` | 获取已提交输入的展示副本 |
| `PATCH /api/threads/:id/queue/:messageId` | 取消并重新提交修改后的文字／即时模式 |
| `PATCH /api/threads/:id/queue` | 取消受影响输入后按新顺序提交 |
| `DELETE /api/threads/:id/queue/:messageId` | 取消选定原生 signal |
| `GET /api/threads/preferences` | 获取个人默认配置 |
| `PUT /api/threads/preferences` | 保存个人默认配置 |

## 验证与部署边界

- `apps/server/src/modules/threads/native-queue.test.ts` 使用真实 Mastra Agent、Memory 和可控模型测试 FIFO、即时输入、断线、停止、重试、取消重入队编辑／排序和历史消息 ID；不调用外部模型。
- `apps/server/src/modules/threads/goals.test.ts` 使用原生 Agent／Memory 和模型 mock 验证目标评估续跑、完成、暂停、关闭竞态、重载恢复、普通消息隔离与接口权限；不代表真实供应商验收。
- `runner.test.ts`、`runner-cancellation.test.ts`、`background-tasks.test.ts` 覆盖原生工具审批／恢复、取消后的保存与后台续跑。PostgreSQL 用例需要测试数据库。
- `scripts/thread-queue.test.ts` 验证原生 session 接入、权限、旧草稿交接和队列 HTTP 接口；状态、导航、历史分页、成员隔离仍由相应脚本覆盖。
- 本次队列迁移未以真实供应商或真实浏览器验收。UI 与流式行为仍需在配置供应商的环境中验收。

当前官方运行队列由一个服务进程持有，部署时使用单实例。页面关闭不会中断运行；进程重启不能继续原模型连接或恢复待处理队列。多实例需要共享执行协调和事件通道后再启用。反向代理需关闭 SSE 缓冲并允许长连接。
