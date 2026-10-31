# Issues

持久化任务记录，分个人和项目范围。数据库迁移 `1780000035000-create-issues.ts` 创建 `issues` 与 `issue_comments`；每个 Issue 绑定一个独立的聊天线程，编号全局递增。项目 Issue 可由当前项目成员共同查看、编辑和执行；个人 Issue 只允许创建者访问。范围不可迁移，工具不能通过命令切换范围。

## 命令工具

`issue` 是内置工具，输入只有 `command` 字符串，在后台工具管理中可独立启停。可省略命令开头的 `issue`，参数包含空格、引号或 Markdown 时使用引号。命令按文本解析，不调用 Shell。

```text
list --state open
list --state 待决策 --limit 20
create --title "完成数据导出" --body "导出 CSV，并验证字段与权限"
create --title "修复登录" --body "复现问题、修复并验证" --start
view 123
edit 123 --title "更新标题" --body "更新验收标准"
edit 123 --state decision
edit 123 --message "按确认的方案继续" --delivery wait
edit 123 --message "先处理新的限制条件" --delivery immediate
edit 123 --stop
comment 123 --body "已确认需求"
close 123
reopen 123
help
```

- 默认创建待办 Issue 和空任务线程，继承当前聊天的模型/Agent 配置；`--start` 会将任务提交到绑定线程。创建成功但启动失败时返回已创建的 Issue，避免误以为没有创建而重复建单。
- 群聊 Bot 创建 Issue 时保留模型和推理设置，新任务使用普通聊天的默认 Agent，不继承仅限聊天室的 Bot；普通成员 Agent 则保留原 Agent 配置。
- 更新只修改显式提供的字段；仅修改标题、状态、关闭或重开不会清空描述，也不会将其他状态重置。`edit --body ""` 可主动清空描述。
- 较长、需要持续追踪或与已有任务高度相关的工作才使用 Issue。先查找并复用相关任务；简单探索、研究、搜索和直接回答无需建单。
- `comment` 只保存评论，不触发模型执行。`edit --message` 复用聊天原生持久化队列：`wait` 等待当前执行结束，空闲时可立即开始；`immediate` 使用原生立即处理语义。
- `edit --stop` 中止活动执行、清空队列、清除目标，并取消后台任务和命令会话，未关闭的 Issue 回到待办。`close` 只标记完成并保留会话，不打断当前回复；需要中止时先执行 `--stop`。
- 执行中为 `in_progress`，回复结束、失败或等待答复为 `decision`，中止为 `todo`。只有显式关闭或设为 `done` 才完成；后台状态事件不会重新打开已经关闭的任务。`reopen` 恢复待办。
- 任务线程在系统指令中携带 Issue 编号，提示先读取当前任务、复用已有记录，并在完成验证后关闭。Issue 线程不能从普通线程删除入口删除，以保留绑定关系及历史。
- 工具收到 AbortSignal 后立即返回「用户中止了操作」，不再提交后续步骤。已经提交给原生队列的工作需通过 `edit --stop` 终止。

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
