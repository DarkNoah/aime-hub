# Issue 使用指南

## 适用场景与范围

Issue 是持久化任务记录，适合较长、需要持续跟踪或与已有任务密切相关的工作。简单问答、搜索、研究和探索可直接处理，无需每次建单。先 `list` / `view` 检查已有任务，相关工作更新原 Issue；任务线程不要为正在执行的同一任务再创建 Issue。

Issue 分个人和项目范围。个人 Issue 只有创建者可访问；项目 Issue 可由当前项目成员共同查看和操作。工具从当前聊天自动获得用户和项目，命令不能指定其他用户、项目或跨范围访问。Issue 编号全局递增，`#123` 与 `123` 均可用作命令中的编号。

## 工具调用与文本语法

使用内置 `issue` 工具，输入只有一个 `command` 字符串：

```json
{"command":"create --title \"修复登录\" --body \"复现登录失败，修复并验证成功与失败路径\" --run-in-thread"}
```

以下示例都是 `command` 的内容，不是终端命令。开头的 `issue` 可省略；参数可用 `--title "内容"` 或 `--title="内容"`。包含空格、换行、Markdown 或 `--` 的值请用单引号或双引号包裹；JSON 中另按 JSON 规则转义引号和换行。命令按文本解析，不执行 Shell、变量展开或 `$(...)`。

## 创建 Issue 与新线程开关

```text
issue create --title "任务标题" [--body "任务描述与验收标准"] [--state todo|decision|in_progress|done] [--run-in-thread]
```

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `--title` | 必填 | 标题，去除首尾空白后 1–240 字符 |
| `--body` | 空字符串 | Markdown 描述，最多 50,000 字符；交给新线程时写清背景、路径、约束、交付物与验收标准 |
| `--state` | `todo` | 初始状态；单独设为 `in_progress` 不会发送任务 |
| `--run-in-thread` | 未设置 | 无值开关：添加后创建独立任务线程并立即提交任务，不接受 `true` / `false` |

不带 `--run-in-thread` 时只保存 Issue，返回 `threadId: null`，不创建线程、不绑定当前对话，也不发送任务。仍可查看、修改、评论、关闭和重新打开，仍可通知关联 Bot；不能使用 `edit --message` 或 `edit --stop`。用户决定执行时，使用 `edit <id> --run-in-thread` 为原 Issue 创建任务线程并提交任务，无需另建 Issue。

带 `--run-in-thread` 时，群聊 Bot、其他 Agent 和普通聊天都使用相同规则：创建独立任务线程并发送首条任务消息。不能与 `--state done` 组合；需要决策后再执行的工作先只记录，不加开关。单独指定 `--state in_progress` 不会启动工作。

兼容旧命令：`--start` 等同于 `--run-in-thread`；`--no-start` 仅创建空闲任务线程，之后可用 `edit <id> --message "任务详情"` 启动。`--no-start` 与 `--run-in-thread` / `--start` 互斥。这两个旧参数也都不接受参数值；新建并执行优先使用 `--run-in-thread`。

启用任务线程时：

- 新线程的 `metadata.issueId` 保存 Issue ID；有关联来源时还保存服务端验证过的 `metadata.issueSourceThreadId`。新线程不会继承来源聊天室的完整历史，任务描述必须自包含。
- 工具继承当前模型和推理设置；群聊专用 Bot 不作为普通任务线程的 Agent，任务改用普通聊天默认 Agent。普通 Agent 的配置会保留。工具没有模型、Agent、项目或线程 ID 的命令参数。
- 首条任务消息包含 Issue ID、标题、描述，以及读取最新要求、记录进展、处理阻碍和验证后关闭的要求。

`create` 和 `edit --run-in-thread` 返回 `{ issue, taskSubmitted }`。`taskSubmitted: true` 表示消息已提交，不代表任务完成；`false` 在仅记录、暂不启动时是正常结果。若 Issue/线程已保存但发送失败，保留并返回原 Issue 和线程、`taskSubmitted: false` 及 `error`。先检查原线程再重试，避免重复建单。

```text
issue create --title "生成导出报告" --body "读取项目数据，生成 CSV，检查列名、行数与访问权限" --run-in-thread
issue create --title "后续优化计划" --body "记录待确认的优化项"
issue create --title "等待排期" --body "已明确的任务及验收标准" --no-start
issue create --title "确认发布方案" --body "需要用户选择发布时间" --state decision
```

## 全部命令

| 命令 | 用途与参数 |
| --- | --- |
| `list [--state open|all|decision|todo|in_progress|done] [--cursor 123] [--limit 30]` | 列表默认 `all`；`open` 排除已完成。`limit` 默认 30，支持 1–100。使用返回的 `nextCursor` 继续查更早编号 |
| `view 123 [--cursor 评论游标]` | 返回最新 Issue 和最近最多 50 条评论/执行消息；本页按时间正序。用 `nextCursor` 读更早历史 |
| `create ...` | 创建，参数见上表 |
| `edit 123 [--title "新标题"] [--body "新描述"] [--state 状态]` | 只改显式提供的字段，至少提供一项；`--body ""` 主动清空描述 |
| `edit 123 --run-in-thread` | 无线程则创建并绑定，已有线程则复用，发送最新 Issue ID、标题和完整描述；可同时修改标题、描述或非 `done` 状态 |
| `edit 123 --message "执行指令" [--delivery wait|immediate]` | 给现有任务线程发送消息；可与标题、描述或非 `done` 状态更新组合 |
| `edit 123 --stop` | 停止任务线程、清空队列，并将未关闭 Issue 置为 `todo` |
| `comment 123 --body "进展或讨论"` | 保存评论；内容不能为空，最多 50,000 字符 |
| `close 123` | 标记为 `done`，保留线程与历史，不中断正在生成的回复 |
| `reopen 123` | 恢复为 `todo`，不自动启动任务 |
| `help` | 查看当前工具帮助 |

状态别名支持 `待决策`、`待办`、`进行中`、`已完成`；`in-progress` 对应 `in_progress`，`closed` 对应 `done`。

### 让已有 Issue 在线程中执行

```text
issue edit 123 --run-in-thread
issue edit 123 --title "更新后的任务" --body "最新任务详情与验收标准" --run-in-thread
```

这是无值开关，不接受 `true` / `false`。没有任务线程时创建并绑定新线程，将同一个 Issue ID 写入 `metadata.issueId`，保留原 Issue 的来源 Bot 关联；已有任务线程时直接复用，不替换其模型或 Agent 配置。新线程沿用调用聊天的模型和推理设置，群聊专用 Bot 替换为普通默认 Agent。

先保存同一命令中的标题、描述和状态修改，再发送包含更新后 Issue ID、标题、完整描述及执行要求的消息。默认 `wait` 投递：空闲时执行，忙碌时排队。每次调用都会提交一条任务消息，重试前查看已有执行消息，避免重复执行；需要补充简短指令或立即处理时使用 `edit --message`。

`--run-in-thread` 与 `--message`、`--stop` 互斥；`--delivery` 仅用于 `--message`。已完成的 Issue 不自动重开，先 `reopen`；也可在获得重开授权后显式 `edit <id> --state todo --run-in-thread`。线程绑定失败会回滚本次编辑并清理新建线程；绑定成功但投递失败会保留 Issue 和线程、返回 `taskSubmitted: false`，再次执行将复用该线程。

### 评论、投递与停止

`comment` 只保存讨论，不直接给任务线程投递指令；有关联 Bot 时，外部评论仍会唤醒 Bot，由它判断如何回应。

`edit --message` 保存为执行消息并送入原生持久化队列，不能为空，最多 50,000 字符。默认 `--delivery wait`：线程空闲时开始，忙碌时等待当前执行结束。`immediate` 使用原生立即处理语义，会打断当前执行。创建后续消息时写清 Issue ID、最新要求和必要上下文；改了描述不代表线程已经收到新指令。

`--delivery` 必须与 `--message` 一起使用。`--stop` 与 `--message` 互斥，也不能与非 `todo` 的状态参数组合。停止会清空队列、清除目标并取消后台任务和命令会话。已关闭 Issue 保持关闭。需要停止后再关闭时依次调用 `edit --stop`、`close`；仅 `close` 不停止执行。

```text
issue view 123
issue comment 123 --body "已完成复现，下一步验证修复"
issue edit 123 --message "Issue #123：用户已确认方案 A，请按描述完成并验证" --delivery wait
issue edit 123 --message "Issue #123：先停止发布，检查新增的限制条件" --delivery immediate
issue edit 123 --stop
issue close 123
```

## 状态与完成条件

| 状态 | 含义与自动更新 |
| --- | --- |
| `todo` | 待办；新建默认值，重开或中止后回到此状态 |
| `in_progress` | 进行中；任务线程运行或等待执行时同步为此状态 |
| `decision` | 待决策/待跟进；一次运行回复结束、失败或等待答复时同步为此状态 |
| `done` | 已完成；必须在验证后显式 `close` 或设为 `done` |

线程一次运行 `success` 不等于任务已完成。任务线程应记录实际结果、交付路径和验证证据，再关闭 Issue；自动运行状态不会重新打开已关闭 Issue。无任务线程的 Issue 由用户或 Agent 显式维护状态。

## Bot 与任务线程协作

启用新线程时，常用流程是：Bot 查重并创建 Issue → 新线程收到 ID 和完整任务详情 → 执行中记录关键进展 → 验证并关闭或说明阻碍 → 关联 Bot 收到事件 → 向用户汇报或发送同一任务的下一步。

- Bot 负责沟通和协调，任务线程负责执行；不要两边重复执行，也不必轮询等待结束。Bot 对用户的回复必须使用聊天室发布工具，例如 `send_message`。
- 事件只通知该 Issue 关联聊天室的 Bot，不广播同项目其他 Bot。来自群聊的工具创建保留来源关联；普通个人/项目聊天的工具创建没有默认 Bot 关联。
- 人手动创建（页面/RPC）会关联当前范围的默认聊天室 Bot，聊天室不存在时创建。个人范围使用创建者自己的默认聊天室；项目范围使用该项目的默认聊天室。创建事件也会唤醒这个 Bot。
- 手动创建后，Bot 先读取最新 Issue。若有任务线程且状态为 `todo` / `in_progress`，将 ID、完整描述与验收标准发送到该线程；已有执行消息时避免重复提交。`decision` 先询问缺失决定，`done` 不启动或重开。`threadId: null` 仅沟通和跟踪记录，不启动工作。
- 创建、编辑、评论、发送执行消息、停止及线程运行结束/失败等会产生事件。无内容变化的编辑不产生事件；Bot 自己通过 Issue 工具发起的操作不会回声唤醒自己。人即使用与 Bot 相同的账号手动修改也会通知。
- 线程结束事件带有 Issue ID、任务线程 ID、运行 ID、状态、结果和错误；持久化队列可重试并按运行去重。Bot 忙碌时消息排队，不打断当前回复。
- 收到事件先 `view` 最新记录，优先考虑之后发生的用户修改。汇报有意义的结果或错误；授权范围内还有工作时用 `edit --message` 继续原任务。尊重停止和关闭，不自动重开、重复建单或反复重试同一错误。
- 关联群聊的任务线程遇到阻碍时，用 `comment` 说明问题、设为 `decision`，结束当前轮。挂起式交互工具不可用；由 Bot 在聊天室询问用户，再将答案送回原线程。

## 页面与接口

个人首页和项目仪表盘提供四种状态的 Issue 看板。创建 Dialog 的“启用新线程”开关默认关闭，开启后创建任务线程并通知 Bot 跟进；保持关闭即仅记录。详情 Sheet 可查看 Markdown 描述、编辑、评论、关闭和重开；有任务线程时还可执行、停止、排队或立即投递消息。

关联聊天室的 Issue 提供来源聊天室入口和任务线程入口；无来源关联时直接打开任务线程。无任务线程时隐藏执行和任务线程入口，保留评论及状态操作。绑定的任务线程不能从普通线程删除入口删除，以保留历史。

应用 RPC 命名空间为 `issues`：`list`、`forThread`、`view`、`create`、`edit`、`close`、`reopen`、`stop`、`comment`、`message`。创建数据中的字段叫 `runInThread`（boolean，默认 `false`），工具存在 `--run-in-thread` 时传 `true`，不存在时传 `false`。范围字段为可选 `projectId`；创建数据还包含 `title`、`body`、`state` 和可选 `settings`。`forThread` 查询某线程绑定的 Issue，未绑定返回 `null`。

Agent 优先使用 `issue` 工具，以保留当前范围和真实操作线程信息。上述 RPC 当前未向 docs 的本机 API 脚本开放，不应直接猜 HTTP 请求或索要 Cookie；若以后开放，以 [应用 API](app-api.md) 的实时 `list` / `describe` 结果为准。

## 错误与恢复

- `ISSUE_NO_THREAD`：此 Issue 尚无任务线程，不能直接 `--message` 或 `--stop`；用户需要执行时使用 `edit <id> --run-in-thread`，否则继续评论和状态更新。
- `ISSUE_CLOSED`：任务已关闭；仅在用户要求或授权允许时重开，再发送任务。
- `TOOL_RESPONSE_REQUIRED`：任务线程仍有待处理交互，先打开线程处理；不要重复提交。
- `ISSUE_BOT_UNAVAILABLE`：手动创建找不到可用的默认 Bot；检查对应聊天室配置后重试。
- 权限/不存在错误：核对当前个人/项目范围和成员权限，不尝试其他身份。
- 创建成功、启动失败：沿用返回的 Issue ID，检查模型或待处理交互，再用 `edit --run-in-thread` 提交完整任务，或用 `edit --message` 发送针对性指令。
- 请求中断或超时：先查看 Issue 和执行消息，确认是否已提交，避免重复操作。工具收到 AbortSignal 会立即返回“用户中止了操作”；已提交给任务线程的工作需用 `edit --stop` 停止。
