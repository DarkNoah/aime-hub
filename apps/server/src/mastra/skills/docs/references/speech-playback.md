# 即时语音播放

用户要求直接朗读、立即播放或边生成边听时，调用 `speech` 并启用 `play_immediately`：

```json
{
  "input": "你好，现在测试边生成边返回语音。",
  "voice": "zh-female",
  "play_immediately": true
}
```

- `input` 是本次实际朗读的文字，`voice` 是本地音色库 ID 或所选模型支持的供应商音色 ID。`zh-female` 是 CosyVoice 服务的预设，不应假设其他模型也支持。
- 不传 `model`，使用后台为工具指定的模型或默认 Speech 模型。
- 工具立即返回 `{status: "queued", playback_id, text}`，仅表示任务已排队，不代表音频已经生成或播放成功。无需等待文件，也不要虚构下载链接。
- 支持流式的模型逐块推送音频和当前文本，前端边收边播。CosyVoice 模型使用 24 kHz、16 位小端单声道 PCM。未启用流式能力的适配器后台生成完整 WAV 后播放。
- 此模式不创建音频文件或素材，忽略 `save_path` 与 `response_format`；当前聊天页面显示播放状态。浏览器阻止自动播放时，用户点击“播放语音”继续。
- 同一会话多次调用按顺序排队，模型回复结束后音频继续播放。播放栏可以单独停止语音；停止当前模型回复也会取消后台语音生成。切换页面或连接断开会停止本地播放，重新连接不重放历史音频。
- 即时播放需要当前聊天会话。自动化或其他无聊天播放通道的调用应关闭 `play_immediately`，保存文件供稍后使用。

需要下载、分享、剪辑或把生成候选保存为音色时，保持 `play_immediately: false`（默认），使用 `save_path` 和 `response_format` 生成文件。克隆参考录音时，仍必须先将参考音频和准确文本保存到音色目录，再使用 `voice` 调用，见 [创建音色](create-voice.md)。本地参考音色克隆目前使用 Xinference 适配器；CosyVoice 通过供应商的音色 ID 选择声音。

管理员为 OpenAI 兼容的 Speech 模型在模型 metadata 中设置 `speechStreaming: true`，可启用 `stream: true` 的 PCM 通路；缺省或 `false` 使用完整音频通路。可用 `speechDefaultVoice` 指定供应商默认音色 ID。此能力标记适用于提供 24 kHz、16 位小端单声道 PCM 的服务，不根据模型名称猜测；CosyVoice 使用现有 `openai` 类型供应商。
