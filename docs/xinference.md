# Xinference 供应商

在后台「供应商」新增 `Xinference`，填写服务地址和可选的 API key / Bearer token。基础地址支持 HTTP(S)，可以包含 `/v1`，省略时会自动补齐。密钥只保存在服务端。

同步模型后，根据 Xinference 的 `model_type` 和 `model_ability` 自动区分聊天、Embedding、Rerank、Speech。语音识别等尚未支持的类型不会被当作聊天模型导入。手动添加或编辑模型时也可以指定类型。

默认模型配置新增「向量模型」「重排模型」「语音合成模型」，选择后自动保存。选择器按类型过滤；默认配置引用的模型不能被停用、删除或改成不匹配的类型。旧配置的三个新增字段默认为空。

升级数据库需要运行项目迁移：`pnpm db:migrate`。新增迁移为 `1780000013000-provider-model-type`，给已有模型设置 `language` 类型。

## 服务端调用

`ProviderService.getEmbeddingModel()`、`getRerankModel()` 和 `getSpeechModel()` 解析对应默认配置；也可以传入完整的 `providerId/modelId` 引用。返回 AI SDK 原生模型对象，可直接交给 `embedMany`、`rerank` 和 `experimental_generateSpeech`。

| 能力 | 接口 | 请求格式 |
| --- | --- | --- |
| 模型发现 | `GET /v1/models` | 按模型类型导入 |
| Embedding | `POST /v1/embeddings` | JSON；按输入顺序返回向量 |
| Rerank | `POST /v1/rerank` | JSON；文本 documents、top_n |
| Speech | `POST /v1/audio/speech` | 无参考音频用 JSON，有参考音频用 multipart |

`speech` 是语音合成，`speed` 是语速参数。默认输出 WAV，也可以通过 `outputFormat` 显式选择 MP3 等格式。生成接口返回完整音频，当前固定 `stream: false`。Xinference 的处理器仅在收到参考文件时解析 multipart；没有文件的 multipart 会触发 `Stream consumed`。

```ts
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { readFile, writeFile } from 'node:fs/promises';

const result = await generateSpeech({
  model: await providers.getSpeechModel(),
  text: '你好，这是一次语音合成测试。',
  outputFormat: 'wav',
  speed: 1,
  providerOptions: {
    xinference: {
      // 不需要参考音频时，省略 promptSpeech 和 prompt_text。
      promptSpeech: (await readFile('/path/to/reference.wav')).toString('base64'),
      promptSpeechMediaType: 'audio/wav',
      kwargs: { seed: -1, prompt_text: '参考音频中的准确文本。' },
    },
  },
});
await writeFile('/path/to/output.wav', result.audio.uint8Array);
```

`kwargs` 保留模型专属参数，由适配器序列化为 Xinference 要求的 JSON 字符串。适配器接收 base64 音频字节，文件读取由上层工作区工具负责。VoxCPM 的 `instructions` 映射为 `control_instruction`；其他模型的表达指令、语言等专属参数通过 `kwargs` 传递。不支持的通用参数会返回 warning。VoxCPM 会忽略 `speed`。

## 语音生成工具

内置工具 ID 为 `speech`，参照 aime-chat 的 `TextToSpeech` 实现。后台「工具」可以启停、指定语音模型和设置超时（默认 300 秒）；模型留空时，每次调用读取当前默认 Speech 模型。Agent 选择工具时也可使用 `speech`。

```json
{
  "text": "你好，很高兴见到你。",
  "instruct": "用自然亲切的语气说话",
  "ref_audio": "references/voice.wav",
  "ref_text": "参考音频中的准确文本。",
  "save_path": "outputs/audio/greeting.wav"
}
```

只需要 `text`；普通合成可省略其他字段。`ref_audio` 和 `ref_text` 必须一起提供，当前使用 Xinference 的参考音频上传接口。参考文件支持工作区相对路径或公开 HTTP(S) URL，格式为 WAV、MP3、FLAC、OGG，最大 20 MB。相同音色的多次生成应使用同一份参考音频。

工具固定生成 WAV，缺省保存到 `outputs/audio/<随机 ID>.wav`，自定义路径也必须以 `.wav` 结尾，且不覆盖已有文件。支持模型允许的 `voice`、`language`、`instruct`、`speed`。成功结果包含路径、实际采样率、时长及受会话权限保护的播放地址，聊天消息可播放/下载，素材库记录为音频。音频字节不写入模型上下文。

消息附件、工具预览和文件预览共用 AI Elements / Media Chrome 播放器，支持进度跳转、播放倍速、静音、下载和加载失败重试。右侧 `speech` 预览优先展示音频、采样率和可复制的生成文本，模型、合成语速、表达指令及参考音频等参数可折叠查看；原始消息入口保留。播放倍速仅影响试听，不改变生成文件。

## 真实接口测试

测试脚本不内置凭据，也不会自动创建或修改后台供应商和默认配置。测试结果音频默认保存在 `/tmp/xinference-speech.wav`。

```sh
# 在环境中安全设置 XINFERENCE_BASE_URL 和 XINFERENCE_API_KEY 后执行：
node --import tsx scripts/xinference-smoke.ts

# 实测完整 speech 工具，包括工作区保存、WAV 校验和素材记录：
XINFERENCE_TEST_TOOL=1 node --import tsx --test \
  --test-name-pattern='live Xinference speech tool' \
  apps/server/src/modules/tools/speech.test.ts

# 同时验证已运行的 Embedding、Rerank 模型：
XINFERENCE_TEST_ALL=1 node --import tsx scripts/xinference-smoke.ts

# 指定已有参考音频，测试 multipart：
XINFERENCE_REFERENCE_AUDIO=/path/to/reference.wav \
XINFERENCE_PROMPT_TEXT='参考音频中的准确文本。' \
node --import tsx scripts/xinference-smoke.ts
```

也可使用权限为 `0600` 的本地 JSON 配置文件（字段 `baseUrl`、`apiKey`），通过 `XINFERENCE_CONFIG_FILE` 指定。不要将密钥提交到仓库。可选参数还有 `XINFERENCE_SPEECH_MODEL`、`XINFERENCE_SPEECH_TEXT`、`XINFERENCE_SPEECH_OUTPUT` 和 `XINFERENCE_REFERENCE_MEDIA_TYPE`。

完整工具测试同样支持上述环境变量，额外支持 `XINFERENCE_SPEECH_INSTRUCT`；测试音频默认保存为 `/tmp/xinference-speech-tool.wav`。真实测试需显式启用，普通测试不访问服务。

## 本次验证（2026-10-13）

- 真实服务：`embeddinggemma-2` 返回两条 768 维向量；`jina-reranker-v3.5` 正确将北京文档排首位；`VoxCPM2` 普通合成、带参考音频合成均成功，缺省 WAV 返回 215,084 字节。
- 工具及相关回归：67 项通过，2 项未启用（真实接口、可选数据库测试）；覆盖原生 Mastra 调用的音频素材记录、参考音频上传、保存边界和前端媒体数据解析。
- 独立 PostgreSQL schema 中，新增迁移、模型同步、默认值持久化和引用保护测试通过。应用数据库未执行迁移，也未写入实际供应商配置。
- 各工作区包类型检查、针对改动脚本的类型检查和 ESLint 通过。全量脚本类型检查仍被已有 `floating-window/storage.ts` 导入缺少 `.js` 后缀阻塞；既有 providers 数据库套件还有全局约束差异及 `deletedAt` 断言失败，独立新增 schema 检查无差异。
- 更新凭据后，完整 `speech` 工具两次真实测试均通过：普通合成输出 230,444 字节、2.4 秒 WAV（耗时约 46 秒）；将该文件作为参考音频上传后，输出 476,204 字节、4.96 秒 WAV（耗时约 95 秒）。两份音频均为 48 kHz、单声道、16-bit PCM，已校验格式、时长和非静音内容。
- 两次真实测试均完成工作区保存、WAV 元数据解析和一次素材记录回调。回调使用测试收集器，未写入应用素材数据库，也未验证浏览器内播放。样例位于 `/tmp/xinference-speech-tool.wav` 和 `/tmp/xinference-speech-tool-reference.wav`。
- 后续播放器优化使用上述真实 WAV 在独立浏览器组件预览中验证：播放、进度跳转、倍速、静音、播放器互斥、重试恢复、复制文本、文件预览入口，以及生成中/失败状态均通过；中英文、浅色/深色、320px 面板与 375px 视口无横向溢出。新增预览解析和相关回归共 18 项通过。当前浏览器处于登录页，未验证登录后的真实会话和受保护音频地址。

官方参考：[Embedding](https://inference.readthedocs.io/en/latest/models/model_abilities/embed.html)、[Rerank](https://inference.readthedocs.io/en/latest/models/model_abilities/rerank.html)、[Audio](https://inference.readthedocs.io/en/latest/models/model_abilities/audio.html)、[REST 处理器](https://github.com/xorbitsai/inference/blob/main/xinference/api/restful_api.py)、[VoxCPM 处理器](https://github.com/xorbitsai/inference/blob/main/xinference/model/audio/voxcpm.py)。
