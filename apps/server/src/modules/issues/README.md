# Issues

持久化任务记录，分个人和项目范围。数据库迁移 `1780000035000-create-issues.ts` 创建 `issues` 与 `issue_comments`；启用任务执行的 Issue 绑定一个独立的聊天线程；迁移 `1780000039000-issue-optional-thread.ts` 允许仅记录的 Issue 使用空 `thread_id`，编号全局递增。项目 Issue 可由当前项目成员共同查看、编辑和执行；个人 Issue 只允许创建者访问。范围不可迁移，工具不能通过命令切换范围。

## 命令工具

面向 Agent 的完整指南位于内置 [docs skill](../../mastra/skills/docs/references/issues.md)。

`issue` 是内置工具，输入只有 `command` 字符串，在后台工具管理中可独立启停。可省略命令开头的 `issue`，参数包含空格、引号或 Markdown 时使用引号。命令按文本解析，不调用 Shell。

```text
list --state open
list --state 待决策 --limit 20
create --title "完成数据导出" --body "导出 CSV，并验证字段与权限"
create --title "修复登录" --body "复现问题、修复并验证" --run-in-thread
create --title "仅记录事项" --body "背景与待办"
create --title "稍后安排的任务" --body "任务与验收标准" --no-start
view 123
edit 123 --title "更新标题" --body "更新验收标准"
edit 123 --state decision
edit 123 --run-in-thread
edit 123 --message "按确认的方案继续" --delivery wait
edit 123 --message "先处理新的限制条件" --delivery immediate
edit 123 --stop
comment 123 --body "已确认需求"
close 123
reopen 123
help
```

- `create` 默认只保存 Issue，返回 `threadId: null`，不创建或绑定线程，不启动任务。添加无值开关 `--run-in-thread` 才创建独立任务线程并提交任务，不接受 `true` / `false`。仅记录的 Issue 仍支持编辑、评论、关闭、重开和关联 Bot 事件；`message` / `stop` 返回 `ISSUE_NO_THREAD`。RPC 创建数据使用 `runInThread`（默认 false），页面提供默认关闭的开关。
- 启用新线程时，首条消息携带 Issue ID、标题、完整任务详情和执行要求。兼容 `--start`（等同于 `--run-in-thread`）和 `--no-start`（只创建空闲线程，不可与前两项同时使用）。工具返回 `taskSubmitted`，创建成功但启动失败时保留并返回原 Issue，后续用 `edit --message` 重试。
- `edit --run-in-thread` 对原 Issue 按需创建并绑定任务线程，已有线程则复用，然后发送最新 ID、标题和描述。可同时编辑任务字段，与 `--message` / `--stop` 互斥。绑定与编辑在同一事务中提交，行锁防止并发创建重复线程；失败时补偿新建线程。投递失败保留线程，并返回 `taskSubmitted: false`。
- 群聊 Bot 创建 Issue 时保留模型和推理设置，新任务使用普通聊天的默认 Agent，不继承仅限聊天室的 Bot；普通成员 Agent 则保留原 Agent 配置。
- 更新只修改显式提供的字段；仅修改标题、状态、关闭或重开不会清空描述，也不会将其他状态重置。`edit --body ""` 可主动清空描述。
- 较长、需要持续追踪或与已有任务高度相关的工作才使用 Issue。先查找并复用相关任务；简单探索、研究、搜索和直接回答无需建单。
- `comment` 只保存评论，不触发模型执行。`edit --message` 复用聊天原生持久化队列：`wait` 等待当前执行结束，空闲时可立即开始；`immediate` 使用原生立即处理语义。
- `edit --stop` 中止活动执行、清空队列、清除目标，并取消后台任务和命令会话，未关闭的 Issue 回到待办。`close` 只标记完成并保留会话，不打断当前回复；需要中止时先执行 `--stop`。
- 执行中为 `in_progress`，回复结束、失败或等待答复为 `decision`，中止为 `todo`。只有显式关闭或设为 `done` 才完成；后台状态事件不会重新打开已经关闭的任务。`reopen` 恢复待办。
- 线程创建时将 Issue 编号写入 `metadata.issueId`；来自群聊的任务还写入服务端验证过的 `metadata.issueSourceThreadId`。系统指令要求先读取当前任务、复用已有记录，记录关键进展、结果与验证证据，并在完成验证后关闭。Issue 线程不能从普通线程删除入口删除，以保留绑定关系及历史。
- 群聊任务线程遇到阻碍或需要用户决策时，通过评论说明问题并设为 `decision` 后结束当前轮；挂起式交互工具不可用。关联 Bot 收到事件后在群聊询问，并通过 `edit --message` 将回复送回原任务线程。
- 工具收到 AbortSignal 后立即返回「用户中止了操作」，不再提交后续步骤。已经提交给原生队列的工作需通过 `edit --stop` 终止。

## Bot 事件闭环

`Bot 创建 Issue → 独立线程执行 → 更新/关闭 Issue → 事件唤醒原 Bot → Bot 向用户汇报或安排同一任务的下一步`。简单任务仍直接处理，无需建单。

页面/RPC 手动新建时，复用当前个人/项目范围的默认聊天室（不存在则创建），关联该聊天室的 Bot，并在创建事务中发出 `created` 事件。人的操作不会冒充 Bot 来源而被过滤。Bot 读取新任务后，仅在有任务线程时向其提交详情；无任务线程时只沟通和跟踪记录；待决策任务先询问，已完成任务不会被自动启动。个人任务只关联创建者自己的默认聊天室，不选择其加入的其他人的聊天室；不广播给同范围的其他 Bot。

迁移 `1780000038000-issue-events.ts` 扩展现有 `group_chat_events` 的 `issue` 类型。创建、修改、评论、投递消息和停止操作，与变更事件在同一个数据库事务内提交；无变化的编辑不产生事件。事件仅发给 Issue 来源聊天室的 Bot，不广播给其他聊天室。工具上下文提供真实操作线程 ID，因此即使用户和 Bot 共用同一 userId，用户手动修改仍会通知，Bot 自己的操作不会回声唤醒。

任务线程的结束、失败、等待决策等事件携带 Issue ID、任务线程 ID、运行 ID、状态、结果文本和错误。事件按运行 ID/状态去重，先在任务线程 metadata 保存待发送事件，再写入群聊持久化队列；写入失败重试，启动时恢复待发送事件及被中断运行的错误。Bot 忙碌时事件进入原生消息队列，不打断当前回复。派发时重新校验用户、聊天室和成员权限。

`success` 仅表示一次模型执行结束，不能自动将 Issue 标记为完成；只有验证后显式关闭才为 `done`。Bot 收到事件后读取最新 Issue，汇报有意义的进展/失败，或在原授权范围内向原线程发送下一步。尊重用户停止、关闭和新指令，不轮询、不自动重开、不重复创建任务。

## 页面与接口

个人首页和项目仪表盘按「待决策 / 待办 / 进行中 / 已完成」显示列表。标题和工具结果直接跳转到对应的个人/项目聊天，并打开右侧 Issues 板块；详情采用 Sheet，创建/编辑采用 Dialog。

RPC 位于 `issues` 命名空间，包含 `list`、`forThread`、`view`、`create`、`edit`、`close`、`reopen`、`stop`、`comment`、`message`。所有操作需要登录，修改遵循现有 Origin 校验。列表按编号游标分页，评论按序列游标分页；看板按需分页并每 15 秒更新可见数据，修改不会重新挂载滚动区域。

## 验证

```sh
node --import tsx --test apps/server/src/modules/issues/*.test.ts
# TEST_DATABASE_URL 指向测试用 PostgreSQL 时，自动创建并清理独立 schema。
node --test scripts/issues-browser.test.mjs
```

数据库测试验证范围权限、关联线程、状态生命周期、评论分页、失败回滚和 RPC 鉴权；原生队列测试使用确定性的本地模型，验证中止、清队列及继续执行；浏览器测试使用实际生产组件和模拟 RPC，验证创建、编辑、评论、立即处理、关闭重开、线程链接及手机布局。
