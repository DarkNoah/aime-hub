# JavaScript 工具编排（exec）

`exec` 在每次调用时创建独立的 QuickJS/WASM 运行环境，用 JavaScript 组合工具调用。它已加入 Agent 的工具选择目录；代码默认 Agent 自动包含它，数据库 Agent 可在编辑页勾选「JavaScript 工具编排」。

MCP 工具不会直接注入 Agent 的工具列表，也不会在构建 Agent 时加载。需要使用 MCP 的 Agent 应启用 `exec`，在执行时通过 `ALL_TOOLS` 查找工具，再通过 `tools.mcp__*` 调用。

## 调用

工具入参仍为 JSON；`code` 字段里填写 JavaScript 源码，不要使用 Markdown 代码围栏：

```json
{
  "code": "text(await tools.read_file({ path: 'README.md' }));",
  "yield_time_ms": 30000,
  "max_output_tokens": 10000
}
```

`yield_time_ms` 是包含工具发现与异步等待的执行超时，默认 30 秒，最多 60 秒。此版本没有后台 cell 或 wait 续接；超时会取消本次执行。

## VM 中的接口

- `ALL_TOOLS`：`{ name, description }[]`，列出调用时可用的应用内置工具、当前工作区工具、技能工具、浏览器工具及已发布并连接的 MCP 工具。
- `tools[name](input)`：调用工具，返回 Promise；工具无需出现在当前 Agent 的直接工具列表中。
- `tools[name].inputSchema`：参数的 JSON Schema，用于了解未直接注入的工具。输入仍由宿主验证。
- `text(value)`：显式添加文字输出。对象会 JSON 序列化，其余不能序列化的值转为字符串。
- `image(value)`：显式添加图片输出。支持 base64 data URL、`{ image_url: dataURL }`、MCP 的 `{ type: 'image', data, mimeType }`，以及 `read_file`/截图工具的 `{ data, mediaType }`。支持 PNG、JPEG、WebP、GIF，能识别 `image/*`，不下载 HTTP 图片。

所有名称都是有效的 JavaScript 标识符。MCP 使用 `mcp__<server>__<tool>`，不追加哈希后缀，名称长度不超过 64；使用目录返回的实际名字，不自行拼接。截断或字符替换后出现重名时会报错，避免覆盖其他工具。

```js
text(ALL_TOOLS.filter((tool) => tool.name.startsWith('mcp__')));
text(tools.read_file.inputSchema);

const results = await Promise.all([
  tools.read_file({ path: 'README.md' }),
  tools.curr_time({}),
]);
text(results);
image(await tools.read_file({ path: 'photo.png' }));
```

只有 `text()` / `image()` 显式生成的内容会进入结果 `content`。普通表达式、`return` 和未传给输出函数的工具结果不会自动返回。运行错误会保留已有输出，附带错误文字和 `isError: true`。

```js
await tools.curr_time({}); // 不输出
return 'hidden';           // 不输出
```

图片使用独立的图片 content block 存储，并通过 Mastra `toModelOutput` 映射为 `image-data`；聊天附件及预览复用已有的图片展示。具体模型供应商的多模态传输支持仍取决于其适配器。

## 执行边界

VM 不注入 Node、`process`、`require`、模块加载器、网络、文件系统、`console` 或定时器。所有外部能力通过 `tools` 桥接，沿用当前调用的 request context、工作区、浏览器及取消信号。宿主对象不进入 VM，只传递 JSON 数据。

后台停用的工具和未发布或未连接的 MCP 不可用。工作区原有的路径约束、只读设置、工具开关及读写检查继续生效。MCP 每次执行仍检查发布状态和版本。`exec` 不暴露自身，防止递归创建运行环境。

需要审批或暂停/恢复的工具必须由 Agent 直接调用，不能在一次性 VM 中暂停后继续。嵌套调用保留输入校验和 `onOutput`，例如图片生成后登记资产。

资源上限：64 MiB VM 内存、约 1 秒累计同步执行时间、256 次工具调用、32 个并发工具调用、单个工具返回 JSON 16 MiB、图片输出合计 10 MiB、最多 1000 个用户输出块。文本预算按每 token 4 个 UTF-8 字节估算，截断不破坏 UTF-8，并设置 `truncated: true`；错误诊断单独保留。

脚本完成、报错、超时或调用方取消时会销毁运行环境，并向未完成的工具传递取消信号。工具是否立即停止取决于其取消支持，已经发生的外部修改不会回滚，因此需要完成的工具必须 `await`。
