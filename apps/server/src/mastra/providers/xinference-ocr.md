# Xinference OCR

在供应商管理中创建 Xinference 供应商，填写网关 Base URL（例如 `http://10.25.97.212:9997` 或带 `/v1` 的地址）及 API Key。内网 HTTP 地址需符合系统现有网络访问策略。

新增模型或编辑已同步模型，将模型类型设为 `OCR`，输入能力选择 PDF、图片，再在默认模型设置中选为 OCR 模型。模型 ID 使用网关实际配置的 ID；同步模型列表时会识别 `model_type: "ocr"` 或 `model_type: "image"` 且 `model_ability` 包含 `ocr` 为 OCR 类型。所有模型均参与同步，不因类型未知或缺失而过滤。未知类型保留原始类型与能力到 metadata.xinference；暂沿用系统默认模型类型，但不推断输入输出能力，可在管理页手动配置。无需数据库迁移。

适配器以 multipart POST 请求 `/v1/documents/parse`，发送 `file`、`response_format`（接口使用已部署的 OCR 模型，不接收 `model` 表单字段），通过 Bearer Header 认证。支持文件字节输入及 HTTP(S) URL 下载后上传；文件下载不会携带网关密钥。PDF 和图片沿用现有文件读取、抽取流程。

- 显式设置 `responseFormat: 'json'`：接受样例中的分页数组或单页对象，每页包含 `markdown`。结果的 `data` 保留完整 JSON（包括 crop_blocks、坐标及来源信息），`markdown` 合并所有页内容，保留 HTML 表格。
- 默认 `responseFormat: 'md'`（或 `providerOptions.response_format: 'md'`）：直接返回 Markdown 文本。格式选项属于服务端 OCR 接口；聊天文件读取和信息抽取默认使用 `response_format=md`，直接消费 Markdown。

接口不支持 PDF 页码参数；文件读取层会先提取 `pdf_pages` 指定的页面再上传，OCR 失败时回退到本地 PDF 文字提取。文件上限 200 MiB，响应上限 20 MiB，默认超时 10 分钟，支持 AbortSignal。样例中的相对图片路径原样保留，接口未提供图片下载地址，因此不会自动下载这些裁剪图片。
