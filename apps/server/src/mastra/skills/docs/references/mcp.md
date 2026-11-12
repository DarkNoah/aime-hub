# MCP 服务管理

## 入口、范围与调用方式

打开“后台管理 → MCP”。管理员可以创建、修改、删除及发布 MCP 服务。配置属于应用全局，不按个人或项目保存；修改、停用和删除会影响使用该服务的会话。OAuth 登录凭据按用户隔离，管理员完成自己的登录不会替其他用户授权。

当前 `mcp.*` 管理接口没有开放给 `APP_API_SCRIPT`。聊天注入的 `APP_API_TOKEN` 不能调用这些接口，即使消息发送者是管理员也一样。通过管理页面操作；没有可用的管理员页面操作能力时，提供配置和具体步骤，说明尚未保存。不要索要或复制登录 Cookie，也不要通过直接修改数据库或配置存储绕过管理接口。

下文的接口名用于解释页面行为与请求结构，不代表能直接运行 `node "$APP_API_SCRIPT" call mcp.create`。本机脚本的发现和认证方式见 [应用 API](app-api.md)；只有运行中的 `list` 确实列出目标接口时，才按 `describe` 返回的实时参数使用脚本。

## 创建 MCP

1. 在列表中查找同名服务，避免重复创建。名称在全局唯一，可用英文字母、数字、下划线和连字符；不能用显示名称替代服务 ID。
2. 点击新增，在“表单”中填写名称和连接配置，或切换到“JSON”粘贴 `mcpServers` 对象。创建支持一次提交多个服务；同批名称也不能重复。
3. 保存后得到草稿（`draft`），尚未向会话提供工具。用户要求启用或接入使用时，再打开发布开关；仅要求保存配置时保留草稿。

连接配置按实际传输方式选择：

| 方式 | 配置 | 注意事项 |
| --- | --- | --- |
| Stdio | `command`、可选 `args` 和 `env` | `command` 填可执行程序，参数逐项放入 `args`；表单中每行一个参数，环境变量每行 `KEY=value`。进程运行在应用后端环境，命令、依赖和路径必须在那里可用。 |
| Streamable HTTP / SSE | `url`、可选 `headers` | 使用服务实际提供的 HTTP(S) MCP 端点；表单中请求头每行 `Header=value`。不传 `command`、`args` 或 `env`。 |
| HTTP OAuth | `url`、`oauth`，可选非 Authorization 请求头 | `oauth: {}` 启用 OAuth，也可填写 `clientId` 和 `scope`。发布后每个用户单独登录；不能同时设置静态 `Authorization` 请求头。 |

`command` 与 `url` 必须二选一。Stdio 不使用 `headers` 或 OAuth。JSON 配置不添加 `type`、`transport` 等字段，后端根据 `command` 或 `url` 判断连接方式。请求头名称不区分大小写，不能重复。

页面 JSON 示例（路径和 URL 都是示例，需替换为用户实际服务）：

```json
{
  "mcpServers": {
    "local_tools": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.mjs"]
    },
    "remote_tools": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

页面会把 `mcpServers` 转成创建接口的 `body.servers` 数组，每项为 `{ name, config }`。`mcp.create` 返回本次创建的服务数组；不要把页面 JSON 原样当作 API 请求体。名称冲突时应定位已有配置，按用户要求修改或另取名称。

## 修改 MCP

在目标服务行点击编辑。表单和 JSON 都可修改名称与连接参数；编辑模式的 `mcpServers` 只能包含一个服务。

- 先读取目标的真实 `id`、当前 `revision`、名称和完整配置。`mcp.update` 使用 `params.id`，请求体为 `{ name, config, revision }`。
- 更新会整体替换 `config`，不是局部合并。保留用户未要求修改的有效字段；切换传输方式时移除旧方式字段，例如 Stdio 改为 HTTP 时移除 `command`、`args`、`env`。
- 保存不会自动改变草稿或发布状态。修改已发布的非 OAuth 服务时，后端先检查新连接并发现工具；连接检查失败时保留旧配置和连接。保存成功后替换运行连接。
- 修改 OAuth 服务的端点、OAuth 客户端／scope 或请求头会清除该服务原有用户授权，用户需要重新登录。OAuth 配置保存成功不表示当前用户已授权或连接已加载。
- 遇到 `MCP_CONFLICT`，说明 `revision` 已过期。重新读取目标，把用户要求的改动应用到最新配置，不能仅换一个版本号就覆盖别人的修改。

## 删除 MCP

在目标行点击删除，在页面弹窗中核对名称后提交。删除使用 `mcp.remove`，传 `params.id` 和 **`query.revision`**，不是请求体。成功为 HTTP 204，无 JSON 内容。

删除会移除配置、清除该服务的 OAuth 凭据和待完成授权，并断开对应运行连接。它不会卸载 Stdio 程序，也不会删除远端服务或撤销外部供应商处的授权。用户仅要求暂时停用时，关闭发布开关即可，保留配置供以后重新发布。

用户已明确指定删除目标时，无需额外增加聊天确认；目标有歧义时先定位。遇到版本冲突或网络中断，先重新查询是否仍存在，不盲目重复删除。只有页面成功反馈或查询证实目标已不存在，才报告已删除。

## 发布、连接状态与授权

- 发布开关对应 `mcp.status`，请求体为 `{ status: "published" | "draft", revision }`。发布非 OAuth 服务会先建立连接并发现工具，失败时不切换为已发布；停用会断开连接。
- OAuth 服务可先发布，再由各用户登录。启用 OAuth 时可使用动态客户端注册，或填写预注册的公开客户端 `clientId`；当前配置不提供客户端密钥字段。回调地址以页面显示为准，为 `<网页来源>/api/mcp/oauth/callback`。
- 会话中需要登录已发布的 OAuth MCP 时，若当前提供 `request_authorization` 工具，直接调用并传真实 `mcpId`，不要嵌入 `exec`；未知 ID 可省略以列出可授权服务。用户在浏览器完成授权后，重新发现工具再继续任务，不索要密码、授权码或 token。
- 发布状态与连接状态不同。`connectionStatus` 为 `unloaded`、`loading`、`loaded` 或 `error`；OAuth 另有 `authStatus`。已发布但未加载或连接失败时使用页面的加载／重试功能，再查看工具列表。
- `mcp.load`、`mcp.test` 和 `mcp.tools` 都要求服务已发布；不能把草稿连接测试当作创建前的必需步骤。验证时读取状态和工具数量，不执行与用户任务无关的 MCP 业务工具。

## 管理接口对照

这些接口当前由已登录的管理员页面调用，写操作还校验页面来源。

| 用途 | 接口 | 参数位置与返回 |
| --- | --- | --- |
| 查询列表 | `mcp.list` | 无参数，返回服务数组 |
| 查询单个 | `mcp.get` | `params.id`，返回完整配置、状态与 `revision` |
| 创建 | `mcp.create` | `body.servers: [{ name, config }]`，返回创建的服务数组 |
| 修改 | `mcp.update` | `params.id`；`body: { name, config, revision }`，返回更新后的服务 |
| 发布／停用 | `mcp.status` | `params.id`；`body: { status, revision }`，返回更新后的服务 |
| 删除 | `mcp.remove` | `params.id`；`query.revision`，成功无响应体 |
| 加载连接 | `mcp.load` | `params.id`，返回服务及连接状态 |
| 测试连接 | `mcp.test` | `params.id`，返回 `toolCount` |
| 查看工具 | `mcp.tools` | `params.id`，返回工具定义列表 |

查询响应包含完整配置，`headers`、`env` 或 URL 中可能有密钥。展示时只保留所需名称、ID、状态、版本和工具数量；不要回显认证值或把完整配置放进日志。失败时按实际结果报告：`MCP_NAME_CONFLICT` 为名称重复，`MCP_NOT_PUBLISHED` 为尚未发布，`MCP_AUTH_REQUIRED` 为当前用户需登录，`MCP_CONNECTION_FAILED` 为连接失败；403 表示权限或调用方式不满足要求。
