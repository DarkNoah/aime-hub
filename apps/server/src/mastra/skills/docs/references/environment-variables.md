# 用户与项目环境变量

## 页面修改

打开“个人设置 → 环境变量”。新增时填写变量名、值和可选说明；点击已有变量的编辑按钮修改，删除按钮移除该用户的配置。普通用户和管理员都在这里管理自己的变量；“后台管理 → 环境变量”管理全局配置。

打开“项目仪表盘 → 环境变量”管理项目共享配置。仅项目所有者和管理员可以查看和修改管理列表；项目成员执行命令时会使用这些变量。不同项目可以保存同名变量。

变量名区分大小写，使用字母、数字、下划线，以字母或下划线开头。值保留首尾空格和换行，允许空字符串。单行值默认隐藏，多行模式以明文编辑。

## 通过本机 API 修改

沿用 [应用 API](app-api.md) 的自动认证和参数发现方式：

```sh
node "$APP_API_SCRIPT" list personalEnvironmentVariables
node "$APP_API_SCRIPT" describe personalEnvironmentVariables.list
node "$APP_API_SCRIPT" describe personalEnvironmentVariables.update
```

- `personalEnvironmentVariables.list` 列出当前用户保存的变量；`get` 读取单个变量。
- `create` 新增变量，`update` 按变量 ID 修改名称、值或说明，`remove` 按 ID 删除。部分更新保留未提交字段；同一用户内重名返回冲突。
- 项目变量使用 `projectEnvironmentVariables.list/get/create/update/remove`，在 `params` 中传入 `projectId`（单项操作另需 `id`）。先用 `describe` 获取参数；所有操作均验证当前用户的项目管理权限，不能用全局管理员身份绕过项目成员权限。
- 先查询并按名称精确匹配已有变量，使用返回的真实 ID；存在时更新，不存在时创建。参数以 `describe` 为准。接口不接受指定其他用户的身份，也不返回全局变量或其他用户的变量。

API 响应包含变量值；不要将原始响应或密钥输出到会话。查询时过滤掉值，例如：

```sh
node "$APP_API_SCRIPT" call personalEnvironmentVariables.list \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(s).map(({id,name,description})=>({id,name,description}))))'
```

以下是修改非敏感示例值的完整调用，`<查询到的ID>` 必须替换为真实 ID；创建、读取和其他更新也应同样过滤输出：

```sh
node "$APP_API_SCRIPT" call personalEnvironmentVariables.update \
  '{"params":{"id":"<查询到的ID>"},"body":{"value":"https://api.example.com"}}' \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const {id,name}=JSON.parse(s);console.log(JSON.stringify({id,name}))})'
```

密钥值只能使用用户提供或明确授权读取的来源，避免在命令文本、日志、普通文件或回复中重复写出。需要保存密钥时优先让用户在页面填写；已有安全来源可通过 stdin 构造 JSON 并用 `call <operationId> --file -` 提交，过滤响应后只报告变量名与结果。不要为了查找某个变量而打印整个环境。配置通过 API 保存，不修改仓库 `.env`、服务进程环境或 shell 配置文件。

## 生效范围

每次新启动 `exec_command` 时读取最新配置，优先级为：全局 < 当前消息发送者的个人变量 < 当前项目变量。空字符串也会覆盖低优先级值；删除项目变量后，下次命令回退到当前发送者的个人或全局值。个人及无项目的插件工作区不会加载项目变量；没有用户身份时不加载个人变量。项目变量不会影响其他项目。已删除项目的变量不会被加载。

应用自动注入的 `SKILL_HOME`、`SKILLS_ROOT`、`BUILTIN_SKILLS_ROOT`、`APP_API_SCRIPT`、`APP_API_URL`、`APP_API_TOKEN`、`APP_THREAD_ID` 和 `APP_PROJECT_ID` 优先于保存的配置，不应作为自定义变量设置。

保存配置无需重启服务，但不会改变已启动进程的环境；`write_stdin` 继续使用原终端启动时的值，需新建命令或终端会话才会更新。这些配置供会话命令和其中运行的技能脚本使用，不用于更改后端服务自身的配置。
