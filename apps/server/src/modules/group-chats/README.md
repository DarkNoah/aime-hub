# 聊天室

个人入口 `/group-chats`，项目入口 `/projects/:projectId/group-chats`。每个范围默认打开最早的聊天室，没有时幂等创建。原有多房间数据和历史消息保留。个人入口仍默认打开自己的聊天室，并可切换到已加入的聊天室。个人聊天室的创建者可添加用户成员，加入后共享聊天室及创建者的 share 目录。项目由当前项目成员共享；项目 owner/admin 可从聊天室添加项目成员，同时开放项目目录，退出项目后不可读写。房间创建者及项目 owner/admin 管理协作 agent，只有创建者或项目管理员可以添加用户成员。

## 未读消息

`group_chat_reads` 按用户和聊天室保存已读 sequence，与 Agent 的 `last_read_sequence` 完全独立。`GET /group-chats/unread` 一次返回当前用户可访问的个人/共享聊天室及各项目默认聊天室的最新他人消息和已读位置，自己的发送和 reaction 不产生未读。左侧个人 Bots、项目 Bots（项目收起时显示在项目行）及个人聊天室切换菜单用蓝点提示。

前端登录布局统一每 2.5 秒刷新一次摘要，隐藏标签页暂停刷新，回到前台立即刷新。聊天室在前台获得焦点且消息区位于底部时，以实际加载的最大 sequence 调用 `POST /group-chats/{roomId}/read`。服务端只推进到请求游标，且不超过当前房间最新消息；已读位置单调递增，避免旧请求覆盖新已读记录或误清除刚到达的回复。刷新页面和不同设备共享已读记录，权限撤销后摘要不再返回对应房间。

## 独立生命周期

每个聊天室至少有一个且只有一个 bot-agent，数据库唯一索引约束其角色。领导 agent 始终启用，不可重命名、切换 agent 配置、启停或单独删除；可修改模型、思考等级和空闲启动时间。可以添加多个 worker agent。每个 agent 成员绑定一个固定专属线程；线程不出现在普通聊天列表，普通线程的运行、重试、设置和删除接口不能接管它。聊天室负责线程创建、配置、停用和清理，复用现有 Mastra 原生执行与记忆能力。更换配置/停用会关闭旧执行会话，删除聊天室会清理专属线程，但不删除个人共享或项目文件。

领导 agent 固定使用 `apps/server/src/mastra/agents/bot-agent.ts` 中的 `code:bot-agent`，`BaseAgent.hidden=true`，不依赖全局默认 Agent。普通线程、Agent 选择列表、默认设置和原生子 Agent 引用均不可使用它。既有房间无需修改数据，运行时按内部 room role 解析固定 bot；领导成员可调整模型、思考等级和空闲启动时间。

`apps/server/src/mastra/agents/group-chat.ts` 的 `createGroupChatAgent(agentId, options, context, create)` 装配房间上下文：领导使用固定定义，协作成员包装所选 agent 配置。专属工具位于 `apps/server/src/mastra/tools/bot-agent.ts`，继承 `BaseTool` 并设置 `hidden=true`，只由房间生命周期显式绑定，公共工具列表、普通线程及 `exec` 延迟发现均不载入。

bot 负责对话、交付、协调，主动提出候选工作，必要时通过消息征求意见；没有值得处理的内容时可以不回复。只有 `send_message` 和 `send_ui` 发布到房间；普通 assistant 输出与最终文本仅保存在专属线程。

个人工作区使用现有 `users/<userId>/shared`，项目使用项目工作区（保留挂载配置）。右侧复用 `ChatWorkspace`，个人默认选中 shared，项目默认项目文件。每个成员的 `MEMORY.md` 位于工作区 `.agents/group-chats/<roomId>/<memberId>/MEMORY.md`，每次执行自动读取，agent 通过文件工具维护。Composite 项目使用现有 `/.uploads/.group-chats/<roomId>/<memberId>/MEMORY.md` 挂载路径，保证文件工具写入与自动读取是同一份文件。

## 非阻塞工具

| 工具                       | 用途                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `send_message`             | 可见消息、回复、reaction、文件交付、向房间其他 agent 派发任务 |
| `send_ui`                  | 将 HTML 面板存为房间消息，立即返回 messageId                  |
| `get_room_info`            | 房间、当前用户成员 ID、agent 成员、身份及状态                 |
| `get_room_messages`        | 按 sequence 游标分页读取历史，不改变未读游标                  |
| `get_room_recent_messages` | 原子获取当前 agent 未读内容，仅标记实际返回的消息已阅         |
| `search_room_messages`     | 房间范围内 BM25 搜索，中文分词和字双元组，英文规范化          |
| `future_plan`              | 持久化带时区绝对时间的一次性计划，到期继续原线程              |

所有具有 suspend/resume schema 或人工审批能力的工具均不挂载；`ask_user`、`submit_plan`、原始 `intelligent_ui` 不可用。未声明的 suspend 调用也会被运行时拒绝。规则覆盖 `exec` 延迟发现的插件/MCP 工具。关闭原生子 agent 委派，协作通过房间的持久化任务事件完成。

`send_ui` 复用现有 IntelligentUI 的 CSP、隔离 iframe、主题和渲染器。面板通过用户点击的 `window.IntelligentUI.send({...})` 或 `data-ui-send` 提交。服务端保存一条新的普通用户消息，记录原面板 ID、提交用户与 JSON 数据，然后按普通房间事件唤醒 bot。不存在 suspend、resume 或工具等待状态。面板可被多人、多次独立使用，网络重试使用同一消息 ID。

Bot 善用 reaction 做简洁反馈，`⭐` 表示共享收藏标记。消息 reaction 菜单支持收藏和取消收藏；`search_room_messages` 接收 `reactions` 标签数组（匹配任一标签），支持与关键词 BM25 搜索组合，也可省略关键词按最新顺序查找收藏。筛选在分页截断之前应用，不改变未读游标。

所有工具在 AbortSignal 触发时立即返回“用户中止了操作”。文件交付验证当前成员权限及文件所属工作区，文件必须真实存在。

## 调度和恢复

Bot 可配置 `idleWakeHours`（小时，支持小数；null 表示关闭，默认关闭）。开启或修改间隔后从当前空闲状态重新计时；运行中不计时，每轮执行结束后重新开始。空闲时间 `idle_since` 保存在数据库，重启不会丢失。达到间隔且该 Bot 没有待执行的 `future_plan`、消息或任务时，创建唯一的持久化空闲事件，继续原线程寻找有价值的工作。投递前再次核对空闲周期、计划与配置；旧周期事件会取消，线程忙或有队列时继续等待。修改此配置不会中止现有执行。需要执行迁移 `1780000029000-group-chat-idle-wake`。

添加协作 Agent 时直接勾选可用配置，沿用其名称，无需填写名称或模型；已加入的配置标记为“已加入”。成员列表的线程入口在当前成员面板内展开只读抽屉，顶部可返回成员列表并保留列表滚动位置，复用历史分页、实时消息与工具预览；文件预览绑定正在查看的 Agent 线程，返回不停止执行，窄屏沿用成员面板抽屉。点击头像或选择提及补全会插入 `@名称` 和一个空格。

用户与 Agent 均可在消息正文中使用 `@名称` 提及本房间成员，输入框提供补全，`get_room_info` 为每个 Agent 返回准确的 `mention` 字符串。同名成员使用 `@成员ID` 消歧。消息保存后为每位被提及且启用的 Agent 原子创建立即到期事件，投递到其已有专属线程，保留发送者身份和原消息 ID/正文；消息重试和重复提及不会重复派发，自己提及自己、代码示例、邮箱和其他房间的成员不触发。普通用户消息仍按 30 秒防抖唤醒领导；直接提及领导时立即投递，不为同一条消息新增防抖事件。Bot 不使用原生 subagents，委派统一通过 `send_message` 的普通 `send` 正文提及完成。

`group_chat_events` 持久化四类事件：用户新消息、agent 任务、一次性计划、空闲启动。用户消息采用 30 秒尾部防抖，每次新消息刷新版本及到期时间；bot 自己发布消息不会触发自身循环。到期事件向固定线程投递当前时间及事件提示，agent 自行读取未读消息。

每秒扫描到期事件，使用条件版本与 60 秒提交租约避免重复领取，事件提交 ID 在重试之间保持稳定。新消息防抖到期后及 @提及事件使用即时消息队列（`isImmediate: true` / `sendMessage`），线程运行中也提交，不等待空闲；定时计划与空闲启动仍等待线程空闲；停用成员不执行；投递前重新验证账号存在且未被禁用，并在线程锁内重新检查 agent 的启用状态及配置。失败的提交最多重试三次，保留错误。计划原始 dueAt 不随忙碌或重试而改变。服务重启后继续扫描尚未提交的事件；已中断的运行在房间读取时显示失败，不伪装为仍在执行。

事件 `completed` 表示已成功投递给专属线程，不代表模型工作成功；执行结果由 agent 状态和房间交付消息表示。模型执行中断不会自动重做可能已发生的外部操作。与现有 ThreadService 一致，一个服务进程负责线程执行；多进程水平扩容需要额外的线程执行所有权协调。

## 存储和接口

新增迁移 `1780000026000-group-chat-agents`、`1780000027000-group-chat-members`，通过 `pnpm db:migrate` 应用。扩展既有 `group_chat_messages`，新增 `group_chat_agents`、`group_chat_reactions`、`group_chat_events`、`group_chat_members`。个人成员按房间记录，创建者隐式保留；项目成员仍由项目服务统一管理。消息包含发送者类型、回复、文件、UI、任务目标；reactions 的唯一键为消息/成员/emoji。历史正文首次 BM25 搜索时补建索引数据。

历史分页使用 `before`/`after` sequence；增量同步使用独立 `afterRevision` 游标，覆盖 reaction 更新，避免改变历史顺序。消息写入与房间锁同步提交；客户端更新原项并保留分页边界、草稿和滚动位置。

共享 oRPC contract 为接口源：除原有房间和消息 CRUD，增加用户搜索/添加、agent 添加/更新/删除、reaction 设置/取消、UI 响应、BM25 搜索、计划读取/取消。身份、scope 和 bot 角色均由服务端控制；写接口沿用登录及 Origin 校验。

## 验证

- `node --import tsx --test scripts/group-chats.test.ts`：提供 `TEST_DATABASE_URL` 后在临时 schema 中验证迁移、权限、唯一 bot、并发发送/未读、消息变更游标、UI 响应、BM25、调度租约和删除恢复；结束清理 schema。
- `node --import tsx --test scripts/group-chat-runtime.test.ts apps/server/src/modules/group-chats/*.test.ts`：工具过滤、立即中止、事件条件领取/重试、固定线程生命周期，以及实际 Mastra runner 的模型模拟集成（消息/UI 发布、最终文本隔离、MEMORY.md 注入）。
- `node --test scripts/group-chats-browser.test.mjs scripts/intelligent-ui-browser.test.mjs`：真实 Chromium 与模拟 RPC，验证消息/分页/重试/草稿、reaction、个人/项目面板、非阻塞 UI 多次提交、安全渲染及窄屏布局。

## A2A 外部成员

在聊天室「成员 → 添加 A2A 成员」创建 API Key，每个 Key 对应独立成员 ID 和显示名，没有本地模型配置或专属线程。个人房间创建者、项目 owner/admin 可创建多个 Key、改名、启停、撤销或删除。明文 Key 仅创建时展示，数据库只保存 SHA-256 哈希和展示用前缀；遗失后创建新成员并撤销旧 Key。撤销使 Key 不可恢复地失效，成员仍显示为已撤销；删除会使 Key 失效并将成员从列表、人数和提及候选中移除。已撤销成员也可删除。删除保留数据库中的作者身份及历史消息，不能再次启用或编辑；操作后局部更新列表，不重载聊天记录。

创建、编辑 A2A 成员时，前端自动将当前 `window.location.origin` 作为隐藏参数 `publicOrigin` 提交并保存。Agent Card 的 JSON-RPC、历史消息和 SSE 地址统一使用该域名，避免反向代理内部地址或 `WEB_ORIGINS` 首项覆盖公网域名；旧成员未保存域名时使用 Agent Card 请求 URL 的 origin，编辑保存可补齐。`publicOrigin` 仅接受不含凭证、路径、查询或片段的 HTTP(S) origin。创建、编辑表单可配置 `description`，使用该成员 Key 读取 Agent Card 时返回其描述；留空或清空恢复默认描述。启停等局部更新保留未提交的域名和描述。

需要迁移 `1780000030000-group-chat-a2a-members`、`1780000031000-group-chat-a2a-member-deletion` 和 `1780000033000-group-chat-a2a-card`；启动服务前运行 `pnpm db:migrate` 应用。管理接口沿用网站登录和 Origin 校验：`POST /api/group-chats/:roomId/a2a-members/:memberId/revoke` 撤销 Key，`DELETE /api/group-chats/:roomId/a2a-members/:memberId` 删除成员并返回 204。

外部成员通过 `Authorization: Bearer <API_KEY>` 访问所属房间，不依赖网站 Cookie。每次读写都重新验证 Key、房间、项目及 Key 创建者的当前管理权限；创建者被禁用、移出项目或降为普通成员后 Key 也失效。它只获得房间消息访问权，不开放文件下载、项目管理或 Agent 私有线程。外部消息的 `senderKind` 固定为 `a2a`，`senderId` 由 Key 决定；本地 Agent 提示明确区分它与人类授权。

服务按 [Mastra A2A 文档](https://mastra.ai/docs/connections/a2a) 的默认 v0.3 JSON-RPC 协议接入，支持文本 `message/send` 和 `message/stream`。两者在消息持久化后返回一个 A2A Message 送达回执，流式请求随后结束；不创建长期 A2A Task、不等待 Bot 回复、不提供推送 webhook。v1.0、文件/data parts 和 taskId 暂不支持，返回对应协议错误。`contextId` 可省略；提供时必须是当前 roomId。

| 地址                                                     | 用途                            |
| -------------------------------------------------------- | ------------------------------- |
| `GET /api/a2a/rooms/:roomId/.well-known/agent-card.json` | 需同一 Bearer Key 的 Agent Card |
| `POST /api/a2a/rooms/:roomId`                            | A2A JSON-RPC                    |
| `GET /api/a2a/rooms/:roomId/messages`                    | 房间历史/增量消息，HTTP 扩展    |
| `GET /api/a2a/rooms/:roomId/events`                      | 房间变化 SSE，HTTP 扩展         |

最小调用（环境变量由外部程序自行配置）：

```sh
curl "$ROOM_A2A_URL" \
  -H "Authorization: Bearer $ROOM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"request-1","method":"message/send","params":{"message":{"kind":"message","role":"user","messageId":"unique-message-1","parts":[{"kind":"text","text":"@Bot 请总结最近的讨论"}]}}}'
```

`ROOM_A2A_URL` 使用 UI 展示的 A2A JSON-RPC 地址。相同 Key 重试时复用 `messageId`，相同正文只落一条消息；更改正文须换 messageId。不同 Key 可以使用相同的客户端 messageId，服务端仍生成独立消息。回复某条房间消息时传 `params.message.metadata.replyToId`，其值为该房间消息的 ID（回执的 `metadata.roomMessageId`）。回执还提供发送者 ID、sequence 和 revision。

Mastra 客户端可以直接使用 UI 展示的完整 Agent Card 地址：

```ts
import { A2AAgent } from '@mastra/core/a2a';

const room = new A2AAgent({
  url: process.env.ROOM_AGENT_CARD_URL!,
  headers: { Authorization: `Bearer ${process.env.ROOM_API_KEY}` },
});
const receipt = await room.generate('@Bot 请检查最近的消息');
console.log(receipt.text); // 送达回执；实际成员回复通过下面的消息接口读取
```

消息接口返回 `{ messages, hasMore, revision }`，每条消息包含发送者 ID/类型/名称、正文、回复关系和 reactions。`before`/`after` 使用消息 sequence，`afterRevision` 用于含 reaction 变更的增量读取，三者互斥；limit 默认 50、最多 100。可以先读取最新一页，再以返回的 revision 订阅后续变化：

```sh
curl "$ROOM_A2A_URL/messages?limit=50" -H "Authorization: Bearer $ROOM_API_KEY"
curl -N "$ROOM_A2A_URL/events?afterRevision=123" -H "Authorization: Bearer $ROOM_API_KEY"
```

SSE 每个 `messages` 事件的 data 也是 `{ messages, hasMore, revision }`，`id` 是 revision。客户端按消息 ID 合并更新、保存最后收到的 revision；重连用 `afterRevision` 或 `Last-Event-ID`。从 0 订阅会分页补齐现有消息，之后约每 2.5 秒检查新变化，空闲时发送心跳。停用/撤销 Key 后连接在下次读取时收到 `revoked` 并关闭；客户端主动断开会立即停止轮询。该流包含所有房间成员的消息，外部程序应按 senderId 避免对自己的消息无限回复。

外部成员发送消息复用房间消息事务、幂等写入和 Bot 防抖；提及本地 Agent 时立即创建任务事件。其他成员可以 `@外部成员`，外部程序从消息流读取并自行响应，不启动本地线程。所有执行事件保留独立发送者身份，执行所需的用户权限取自 Key 创建者并经当前权限校验。

验证：`node --import tsx --test apps/server/src/modules/group-chats/a2a-routes.test.ts` 覆盖真实 Mastra A2AAgent 普通/流式客户端、HTTP 协议错误、身份隔离、SSE 重连与中止；`TEST_DATABASE_URL=... node --import tsx --test scripts/group-chat-a2a.test.ts` 在随机临时 schema 验证迁移、凭证哈希、独立成员、权限、启停与撤销；现有 `scripts/group-chats-browser.test.mjs` 包含 A2A 管理交互。
