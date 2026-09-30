# 个人聊天

本阶段实现 `/threads` 与 `/threads/:threadId`，项目聊天仍保持待开放。

## 组件与目录

- `apps/web/src/components/chat/`：完整、可嵌入的 `ChatPanel`，包括消息、推理过程、工具结果、图片、模型设置、输入、队列、运行状态和历史分页。通信 Hook 与 transport 同目录组织，无 React Router、页面高度或定位依赖。
- `apps/web/src/pages/threads/`：页面路由适配、侧栏聊天折叠列表、会话共享状态、重命名／删除 Dialog、个人设置 Sheet。列表每页 10 条，向下滚动自动加载；更新单项保留分页与滚动位置，页面不再单独显示一列列表。
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

## 数据与运行

线程及消息使用 Mastra 原生存储，资源归属为 `user:<userId>`。每个查询、订阅与变更均检查当前登录用户，普通用户只能获取不含凭据的模型目录。写接口校验 Origin；创建线程和发送消息不接受客户端指定 resourceId 或工作路径。

Mastra 使用现有 PostgreSQL 中独立的 `mastra` schema，由官方 `PostgresStore.init()` 初始化。业务偏好使用现有 TypeORM `settings` 表，键为 `chat:user:<userId>`。不会新增自定义线程或消息表。

模型优先级为当前消息／线程选择、个人默认、系统默认。系统默认由供应商管理页面配置；`.env` 中预留的 `OPENAI_API_KEY`／`DEFAULT_MODEL` 不作为绕过供应商管理的隐式连接。供应商凭据只在服务端解析，模型 ID 含斜杠时保留完整后缀。

每轮 Agent 开启 thread scope 的 Observational Memory，使用本轮解析出的模型。支持工具调用的模型接入受目录边界约束的 Mastra Workspace 和 filesystem path skills。工作目录为 `WORKSPACE_ROOT/users/<userId>/<yyyy-MM-dd>-<nanoid(6)>`，日期使用 Asia/Shanghai。全局与个人 `.skills` 递归发现 `SKILL.md`，按包目录名作为 skill ID、相对父目录作为分组；个人同名包覆盖全局包。

HTTP 仅提交新消息，AI SDK `useChat` 的 transport 收到接受响应后即可再次发送；独立 SSE 订阅负责更新消息。首次订阅发送缓存快照，之后只推送变化消息及线程状态，流式更新最多每 50ms 合并发送。重连刷新最新历史窗口后叠加实时消息，历史分页使用固定时间上界，避免后续新增消息导致分页移动。

每个线程串行执行，消息 ID 支持重试去重。队列最多 20 条且总序列化大小不超过 16 MiB；输入支持文字和最多 4 张图片，每张不超过 2 MiB。队列与近期已接受 ID 存在 Mastra thread metadata 中。立即消息通过 `prepareStep` 在当前工具调用完成后的下一步注入；若当前轮没有后续步骤，则紧接当前轮运行。停止会保留部分回复并暂停剩余队列，可继续或移除排队消息。

## 接口

| 接口 | 用途 |
| --- | --- |
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
| `DELETE /api/threads/:id/queue/:messageId` | 移除排队消息 |
| `GET /api/threads/preferences` | 获取个人默认配置 |
| `PUT /api/threads/preferences` | 保存个人默认配置 |

## 验证与部署边界

- `scripts/threads.test.ts`：归属权限、每页 10 条、列表并发请求合并与增量更新、分页重试、并发串行化、断开订阅不停止、重复提交、立即／排队、暂停恢复、进程重启提示、固定历史分页、附件验证、历史合并和 skills 覆盖。
- `scripts/threads.integration.test.ts`：真实 PostgreSQL、Mastra Memory、Agent、HTTP/SSE 与本机 OpenAI 兼容测试服务；包含持久化 ID 一致性、停止保存部分回复、队列恢复、Workspace 工具调用后的立即注入。需要 `TEST_DATABASE_URL`，只创建并清理随机命名的测试 schema。
- 浏览器验证使用隔离测试服务，已覆盖实际页面的发送、多轮、刷新，以及 390px 窄屏与独立 420×620 容器中的排队、停止、继续。侧栏验证了 10→20→23 条自动分页、折叠展开、重命名保留滚动位置及移动导航选中后收起。没有调用真实供应商；真实模型的思考等级、图片理解和长上下文触发 OM 仍需配置对应供应商后验收。

当前运行队列由一个服务进程持有，部署时使用单实例。页面关闭不会中断运行；进程重启不能继续原模型连接，会提示中断，保留已写入消息与队列供用户继续。多实例需要共享执行锁和事件通道后再启用。反向代理需关闭 SSE 缓冲并允许长连接。
