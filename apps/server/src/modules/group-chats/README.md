# 聊天室

个人入口为 `/group-chats`，项目入口为 `/projects/:projectId/group-chats`（项目概览中的“聊天室”按钮）。前端每个范围仅展示一个默认聊天室，进入后直接聊天，没有列表、新建、切换、重命名或删除入口。支持文本消息、历史分页和草稿恢复。本阶段不运行 Agent bots。

默认入口优先复用当前范围最早创建的聊天室，没有时自动创建。并发进入同一范围时共用同一个默认聊天室。后端与数据库仍保留多聊天室能力，已有的其他聊天室和消息不删除。

## 权限与存储

- 个人聊天室仅创建者可见。
- 项目聊天室由项目的当前成员共享，不维护第二套成员关系；移出项目后不可继续读取或发送。
- 项目成员均可创建、发送；创建者和项目 owner/admin 可重命名、删除聊天室。
- `group_chats` 保存聊天室，`group_chat_messages` 保存消息、发送用户、创建时间和 bigint 顺序号。删除聊天室级联删除消息。
- 迁移：`1780000024000-create-group-chats`，使用 `pnpm db:migrate` 应用。

## 接口

列表和管理接口保留供后续使用，当前前端仅调用默认入口及聊天接口。以下 HTTP 路径均在 `/api` 下，同时通过共享 oRPC contract 暴露。需要有效登录会话；写请求遵循现有 Origin 校验。

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| POST | `/group-chats/default` | `{ projectId? }`，幂等打开或初始化默认聊天室 |
| GET | `/group-chats` | `projectId?`、`page`（从 0 开始）、`perPage` |
| POST | `/group-chats` | `{ title, projectId? }` |
| GET | `/group-chats/{roomId}` | 返回聊天室、当前 `memberIds`、`canManage` |
| PATCH | `/group-chats/{roomId}` | `{ title }` |
| DELETE | `/group-chats/{roomId}` | 删除聊天室和消息 |
| GET | `/group-chats/{roomId}/messages` | `before?` 或 `after?`、`limit`（默认 50，最多 50） |
| POST | `/group-chats/{roomId}/messages` | `{ id, text }`，最多 20,000 字符 |
| POST | `/users/lookup` | `{ userIds: string[], roomId?: string }`，每批最多 100 个 ID |

消息分页返回 `{ messages, hasMore }`。`messages` 始终按数值顺序升序返回，`sequence` 使用字符串传输，避免 JavaScript 整数精度损失。初次加载最近一页，历史使用最早消息的 sequence 作为 before，新消息使用上次同步位置作为 after。

消息 id 由客户端生成；同一聊天室重复提交相同 id、发送人及文本返回原消息，冲突返回 409。发送人和时间由服务端决定。发送在同一个聊天室内串行提交，避免增量游标跳过未提交的消息。

成员查询只返回 `{ id, name, username, image }`，不暴露邮箱或认证字段。默认只可查询本人和共同项目的当前成员；指定有权访问的 roomId 时也可解析该聊天室的历史发言者。未知或无权查询的 ID 被忽略，重复 ID 去重。

## 前端复用与同步

复用 `ChatConversation`、`ChatHistoryLoader`、AI Elements `Message` / `PromptInput`、shadcn Avatar / Sheet / ScrollArea。聊天室拥有独立草稿作用域，不覆盖 AI 线程草稿。

当前采用 2.5 秒增量轮询，页面隐藏时暂停，恢复后按游标追赶；每 5 次轮询更新成员信息。新消息合并不重置历史页或滚动位置。失去访问权限后清除当前界面中的消息并关闭输入。实时推送、附件和 bots 留待后续扩展。

## 验证

- `node --import tsx --test scripts/group-chats.test.ts`：schema/草稿边界，提供 `TEST_DATABASE_URL` 后在独立临时 schema 中运行 PostgreSQL、权限、并发发送、分页与 HTTP/RPC 集成检查，结束后清理。
- `node --test scripts/group-chats-browser.test.mjs`：真实 Chromium、生产组件与模拟 RPC，验证头像、历史加载、响应丢失后的幂等重试、草稿恢复、新消息同步、权限失效与窄屏布局。可通过 `CHROME_PATH` 指定 Chrome。
