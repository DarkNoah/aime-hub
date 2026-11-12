---
name: docs
description: 本应用的功能文档与本机 API 脚本。支持查询当前可用 Agent 列表、Issue 任务管理、可选任务线程及 Bot 事件协作，管理线程、消息、项目、个人及项目环境变量；脚本自动使用当前用户的短期认证环境。提供 MCP 服务创建、修改、删除与发布的管理说明。也覆盖音视频转录、即时语音播放、创建和复用音色、保存录音及共享音色。用户要求操作或了解本应用的这些功能时使用。
metadata:
  short-description: 可用 Agent、Issue 任务、MCP 管理、应用接口脚本、环境变量与音视频文档
---

# 应用使用文档

根据本应用实际提供的工具、API 和文件约定回答或执行任务。当前收录可用 Agent、Issue 任务、线程、消息、项目、个人及项目环境变量接口、MCP 管理及音视频场景；其他功能没有文档时，不推测其接口或行为。

## 场景索引

- **获取当前可用 Agent 列表、查询默认 Agent 或选择 Agent 配置**：阅读 [应用 API](references/app-api.md) 的“可用 Agent”部分，通过 `node "$APP_API_SCRIPT"` 查询 `agents.available`。当前项目会话使用 `APP_PROJECT_ID` 指定范围；个人会话不传项目。使用接口返回的真实配置 ID。

- **创建、查询、更新或完结 Issue，启动/继续/停止任务线程，处理 Bot 的 Issue 事件**：阅读 [Issue 使用指南](references/issues.md)。使用 `issue` 工具的 `command` 参数；`create` 默认仅记录 Issue，添加无值开关 `--run-in-thread` 才创建独立任务线程并提交任务。已有 Issue 使用 `edit <id> --run-in-thread`：没有线程则创建并绑定，有线程则复用，然后发送最新任务详情和 Issue ID。指南包含全部命令、参数、状态、手动创建、事件通知及故障处理。简单问答无需建单，相关工作优先复用已有 Issue。

- **新增、修改、查询或删除个人及项目环境变量**：阅读 [环境变量](references/environment-variables.md)。个人入口为“个人设置 → 环境变量”，API 为 `personalEnvironmentVariables.*`；项目入口为“项目仪表盘 → 环境变量”，API 为 `projectEnvironmentVariables.*`，需项目管理权限。先确认作用范围并查变量 ID，再按用户要求修改，不回显密钥。

- **创建、修改、删除、发布或停用 MCP 服务**：阅读 [MCP 管理](references/mcp.md)。入口为“后台管理 → MCP”，配置为管理员管理的全局资源，支持 Stdio、Streamable HTTP / SSE 和 HTTP OAuth。文档包含表单与 JSON 配置、管理接口、版本冲突及生效规则；当前 MCP 管理接口未开放给 `APP_API_SCRIPT`，不能用聊天短期令牌调用。

- **创建或查询线程、发送或读取消息、列出或创建项目**：阅读 [应用 API](references/app-api.md)，通过 `exec_command` 运行 `node "$APP_API_SCRIPT"`：先 `list` 找接口，`describe <operationId>` 获取实时参数，再 `call <operationId>` 执行。接口定义由后端自动生成，本技能只描述用途和流程。服务端自动注入脚本完整路径 `APP_API_SCRIPT`、当前消息发送者的 `APP_API_URL` 与 `APP_API_TOKEN`；不要索要、打印或保存认证。

- **转录音频或视频**：阅读 [音视频转录](references/transcriptions.md)。将媒体文件路径或公开直链传给 `transcriptions.file`，视频会自动提取首条音轨并转为 WAV 后识别。

- **即时朗读、边生成边播放**：阅读 [即时语音播放](references/speech-playback.md)。使用 `play_immediately: true`，工具立即完成，音频通过会话事件播放，不保存文件。

- **创建、保存、共享或复用音色**：阅读 [创建音色](references/create-voice.md)。包括 `speech` 设计声音、通过 `voice` 复用音色、直接克隆参考录音、上传录音、确认样本和描述，以及个人与共享目录的存储约定。

只读取当前任务需要的文档。工具参数以当前可用的工具 schema 为准，不照搬其他应用的工具名、文件名、目录或接口。

通过 `speech` 设计新音色时，先在当前会话工作区生成可试听的候选。只有用户确认所选样本和保存范围后，才将选中的音频及对应文本写入正式音色库。生成候选本身不代表已保存音色。

上传音频直接入库时，沿用用户上传的录音；未提供对应文本，必须先调用 `transcriptions` 获取转写，再按确认的个人或共享范围保存。

生成语音时，必须二选一：传 `voice` 复用音色库或供应商音色，或者同时传 `reference_audio` 与 `reference_text` 直接克隆参考录音；不能都不传，也不能混用。直接克隆无需先入库，参考音频可用会话工作区路径、`list_voices` 的 `audioPath` 或公开 HTTP(S) 音频 URL，文本必须准确对应参考录音。`speech` 使用 `input`、`instructions` 等 OpenAI 风格字段并保留 `save_path`，模型由后台配置；参考音频克隆需兼容的 Xinference 模型，或支持 `reference_audio` 与 `reference_text` 的 OpenAI 兼容模型。
