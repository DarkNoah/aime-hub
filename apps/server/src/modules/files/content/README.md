# 文件内容读取

`readFileContent({ path, parameters, model }, context)` 是共用路径入口。
`path` 支持工作区路径（包括 `/.uploads/`、LocalFilesystem 和 AgentFS 挂载）及 HTTP(S) URL；
本地路径的访问权限由 `context.filesystem` 决定。已有字节数据的调用方可用
`parseFileContent({ data, fileName, mimeType? }, { parameters, model, signal }, dependencies)`，
知识库目前复用此入口。

```ts
const result = await readFileContent(
  {
    path: 'report.pdf',
    parameters: { pdf_pages: '1-3,5' },
    model: { reference: 'provider/model', modalitiesInput: ['text', 'image'] },
  },
  { filesystem, signal, resolveOcr, transcribe },
);
// result.text / format / images? / sheets? / warnings?，以及路径、MIME、大小等元信息。
```

`model` 表示当前消费内容的模型及其输入能力。OCR 和语音转写通过依赖注入，
复用应用已有的供应商设置；`read_file` 和 `extract` 使用同一套 OCR / ASR 解析逻辑。
`transcribe(data, signal)` 接收原始音视频字节，工具层注入的实现负责音频规范化并调用已有 ASR 服务。

| 文件                                             | 结果                                                                   | 动态参数                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| UTF-8 文本、Markdown、HTML、CSV、JSON 等平面文件 | 原文本，保留 BOM、换行及空白                                           | 无                                                                                            |
| WAV、MP3、M4A、OGG、AAC、FLAC 等音频             | STT 文本                                                               | 无                                                                                            |
| 图片                                             | OCR 文本；当前模型支持图片时同时返回 `images`，含 base64、MIME、文件名 | `image_base64: false` 可关闭图片附带                                                          |
| PDF                                              | Markdown，优先配置的 OCR；未配置 OCR 时解析文字层                      | `pdf_pages: "1-3,5"` 或页码数组                                                               |
| DOCX、ODT、RTF、EPUB 等                          | Markdown                                                               | 无                                                                                            |
| XLSX、ODS                                        | 工作表样例 Markdown，附原始行列坐标、工作表大小和样例范围              | `excel_sheet`: 名称或从 1 开始的序号；`excel_range: "A1:D20"`；`excel_rows`: 正整数或 `"all"` |
| PPTX、ODP                                        | 按幻灯片组织的 Markdown                                                | `ppt_slides: "1-3,5"` 或页码数组                                                              |
| MP4、MOV、AVI、MKV、WebM 等视频                  | 音轨 STT 文本，不分析画面                                              | 无                                                                                            |

共用层没有字符数和行数裁剪。Excel 默认取每张表前 20 个非空行，`sheets[].sampled`
明确标记样例；指定 `excel_rows: "all"` 读取所选范围全部数据。
`extract` 和知识库默认指定全量，`read_file` 默认样例。
`read_file` 单次返回最多 100,000 字符，`offset` / `limit` 在转换后的文本上生效；
`nextOffset` 用于继续读取。极长单行无法通过行偏移恢复时会明确提示拆分文件。
`extract` 超过 1,000,000 字符时报错，不会基于静默裁剪后的来源抽取。
这些预算和知识库分块限制均在调用层。

共用层保留输入、解压和解析安全限制：文件最多 200 MB，解压最多 64 MB / 5,000 条目，
解析器报告不完整内容时失败而非返回静默截断的文本。
中止信号会立即停止等待并传递到解析器、下载、OCR 和 ASR。
扫描 PDF 需要配置 OCR；图片未配置 OCR 时仅在当前模型支持图片输入的情况下返回图片，
并附明确的 OCR 缺失提示。原始多模态图片支持 PNG/JPEG/GIF/WebP，其他支持的图片格式使用 OCR。
旧版 DOC/XLS/PPT 需先转换为新版 Office 或 PDF。
