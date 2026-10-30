# 应用 API 的发现与调用

通过 `exec_command` 执行 `node "$APP_API_SCRIPT"`。脚本从运行中的后端读取 `/api/local-api/openapi.json`，自动发现已开放接口、HTTP 路径、参数、必填项和默认值。不要从记忆猜测参数，先查看最新定义。

## 通用用法

`APP_API_SCRIPT` 由服务端自动注入，指向内置 `app-api.mjs` 的完整绝对路径（`$BUILTIN_SKILLS_ROOT/docs/scripts/app-api.mjs`）；直接引用它，不拼接目录或硬编码机器路径。`BUILTIN_SKILLS_ROOT` 指向 `<WORKSPACE_ROOT>/.agents/skills/builtin`；`SKILLS_ROOT` 仍指向全局技能目录 `<WORKSPACE_ROOT>/.agents/skills`，`SKILL_HOME` 表示当前用户或项目的技能安装目录。通过 `write_stdin` 续接的 shell 会话保留 `exec_command` 启动时注入的这些变量，可以使用同样的命令。

```sh
node "$APP_API_SCRIPT" list
node "$APP_API_SCRIPT" list 项目
node "$APP_API_SCRIPT" describe projects.create
node "$APP_API_SCRIPT" call projects.create '{"body":{"name":"产品调研"}}'
node "$APP_API_SCRIPT" call threads.list '{"query":{"page":0}}'
```

- `list [关键词]`：列出接口 ID 和用途，可按名称或描述筛选。
- `describe <operationId>`：读取当前接口参数、请求体、默认值与响应定义。`parameters` 中的 `in:path` 对应 `params`，`in:query` 对应 `query`，`requestBody` 对应 `body`。有引用时随响应提供 `components`。
- `call <operationId> [JSON]`：根据实时定义调用现有接口；JSON 统一使用 `{"params":{},"query":{},"body":{}}`，不用的部分省略。
- 长文本使用 `call <operationId> --file request.json`，或 `--file -` 从 stdin 读取。文件只保存业务参数。成功返回原始 API JSON；204 返回 `null`；失败为非零退出码。

脚本处理 JSON API，不处理文件上传、二进制下载或 SSE。参数和业务规则最终由后端校验。部分接口响应仅定义了 TypeScript 类型，OpenAPI 不包含完整响应字段；不要把空 schema 当作空响应。

## 线程、消息与项目的业务约定

- 查找已有线程，使用 `threads.list`；默认是当前用户个人线程。查询项目线程时指定项目，插件专属线程按插件筛选。先查真实 ID，再操作；分页从 0 开始，按 `hasMore` 翻页。
- 创建新会话用 `threads.create`；它只创建线程，不自动发送消息。用户明确要求发送内容或执行任务后，才调用 `threads.run`。
- 发送前用 `threads.get` 读取目标线程，沿用其中的模型、Agent 和推理设置，除非用户要求修改。按 `describe threads.run` 构造请求体，每条新消息提供唯一消息 ID（例如 UUID）与消息内容。通用调用器不生成业务字段，也不补写模型设置。
- 发送返回 202 表示已接收，运行中可能排队，不表示回复完成。用 `threads.get` 查看状态和最新消息；遇到暂停、等待用户或失败时报告，不无限轮询。不要向当前线程重复发送正在执行的任务。
- 查历史消息使用 `threads.history`，不是 SSE 消息接口。读取更早的完整消息页时沿用首个响应的 `anchor`；摘要视图按 `cursor` 翻页，详情使用 `threads.turn`。
- `projects.list` 列出当前用户有权访问的项目；`projects.get` 读取详情；`projects.create` 创建项目并将当前用户设为所有者。自定义工作区或 GitHub 来源的字段以 `describe` 为准，克隆超时后先检查是否已创建。

这些描述负责解释用途和流程，接口字段不在此重复维护。需要其他能力时先 `list` 查找，不要求手改脚本增加命令。

## 自动认证

每次聊天运行时启动 `exec_command` 时，自动注入 `APP_API_URL`（`http://127.0.0.1:<实际端口>/api`）、当前消息发送者的 `APP_API_TOKEN`、`APP_THREAD_ID` 和 `APP_PROJECT_ID`（个人会话为空）。共享项目随消息发送者切换身份。

令牌有效期 15 分钟，仅能调用后端明确开放的接口，仍遵循线程所有权、项目成员权限和账号状态。它不写入数据库、提示词或文件，服务重启后失效。不要输出 token、打印全部环境变量、复制 Cookie 或把认证放到业务参数中。脚本仅访问本机地址，禁止跟随重定向。

401 时用新的 `exec_command` 获取新令牌，旧终端环境不会自动刷新；403/404 时检查权限和目标，不换用其他用户身份。没有当前用户的任务不会获得用户令牌。超时或连接中断后，写入结果可能未知，先查询再决定是否重试；脚本不会自动重试写操作。

## 开发维护约定

接口的唯一来源是 `packages/shared/src/rpc/` 的 oRPC 契约。后端开放某个接口时，在该 procedure 上添加 `.meta({ localApi: true })`，用途写入已有 `.route({ summary, description, ... })`，参数继续使用原有 `.input(...)` schema。发现目录和认证检查读取同一个标记，不再维护另一份接口白名单或脚本路由表。

后端加载新契约后，新接口及字段变化会自动出现在 `list` / `describe` 中，通用 `call` 即可使用。这里只需补充业务用途、选择规则或流程。该认证目录在生产环境也可用；公开的开发文档入口仍由原来的环境开关控制。
