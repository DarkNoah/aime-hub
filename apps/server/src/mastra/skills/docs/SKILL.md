---
name: docs
description: 本应用的功能与使用约定文档。目前覆盖音视频转录、即时语音播放与音色管理：用 transcriptions 转录音频或视频，视频会先提取音轨并转为 WAV；用 speech 设计候选音色，或通过 voice 复用音色库、通过 reference_audio 和 reference_text 直接克隆参考录音，经用户确认后保存到个人或全局共享音色库；也支持上传音频直接入库，未提供文本时先用 transcriptions 识别。包括音色描述、查找和复用。用户问“转录这个视频”“如何创建音色”“帮我做几个音色”“保存这段录音”或“共享音色”时使用。
metadata:
  short-description: 应用使用文档与音色创建流程
---

# 应用使用文档

根据本应用实际提供的工具和文件约定回答或执行任务。当前收录音视频转录、语音播放与音色场景；其他功能没有文档时，不推测其接口或行为。

## 场景索引

- **转录音频或视频**：阅读 [音视频转录](references/transcriptions.md)。将媒体文件路径或公开直链传给 `transcriptions.file`，视频会自动提取首条音轨并转为 WAV 后识别。

- **即时朗读、边生成边播放**：阅读 [即时语音播放](references/speech-playback.md)。使用 `play_immediately: true`，工具立即完成，音频通过会话事件播放，不保存文件。

- **创建、保存、共享或复用音色**：阅读 [创建音色](references/create-voice.md)。包括 `speech` 设计声音、通过 `voice` 复用音色、直接克隆参考录音、上传录音、确认样本和描述，以及个人与共享目录的存储约定。

只读取当前任务需要的文档。工具参数以当前可用的工具 schema 为准，不照搬其他应用的工具名、文件名、目录或接口。

通过 `speech` 设计新音色时，先在当前会话工作区生成可试听的候选。只有用户确认所选样本和保存范围后，才将选中的音频及对应文本写入正式音色库。生成候选本身不代表已保存音色。

上传音频直接入库时，沿用用户上传的录音；未提供对应文本，必须先调用 `transcriptions` 获取转写，再按确认的个人或共享范围保存。

生成语音时，必须二选一：传 `voice` 复用音色库或供应商音色，或者同时传 `reference_audio` 与 `reference_text` 直接克隆参考录音；不能都不传，也不能混用。直接克隆无需先入库，参考音频可用会话工作区路径、`list_voices` 的 `audioPath` 或公开 HTTP(S) 音频 URL，文本必须准确对应参考录音。`speech` 使用 `input`、`instructions` 等 OpenAI 风格字段并保留 `save_path`，模型由后台配置；参考音频克隆需兼容的 Xinference 模型，或支持 `reference_audio` 与 `reference_text` 的 OpenAI 兼容模型。
