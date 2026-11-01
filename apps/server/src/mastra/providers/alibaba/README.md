# Alibaba Model Studio

`alibaba` and `alibaba-cn` use the Alibaba provider. Coding/token plan provider
types retain their existing compatible clients.

In provider settings, configure the chat API base URL, API key, Workspace ID
(`metadata.workspaceId`) and region (`metadata.region`, default `cn-beijing`).
The region must match the API key. Sync models to import the native speech,
ASR and 3D catalogs with the correct model types. Chat keeps using the configured
compatible URL; native endpoints follow the reference provider's workspace/region
routing, including the separate DashScope Qwen3 TTS endpoint.

The Workspace ID and region form fields are declared in
`AlibabaProvider.configuration`, using the common provider configuration mechanism
described in `../README.md`. The frontend contains no Alibaba-specific fields.

- Speech: Qwen Audio, CosyVoice, Qwen3 TTS and MiniMax families. Custom voice
  models require an existing Alibaba voice ID. Direct reference-audio cloning is
  unsupported. Generation/downloads have no imposed timeout and honor cancellation.
- Transcription: synchronous Flash/Qwen3 ASR and asynchronous Filetrans,
  Fun-ASR and Paraformer. Local files use inline audio or model-bound temporary
  OSS uploads. Responses are normalized for the existing AudioService and
  `transcriptions` tool. Text-only Qwen3 Flash cannot produce SRT/VTT timestamps;
  verbose JSON requires language and duration from the upstream model.
- 3D: `Tripo/Tripo-H3.1` and `Tripo/Tripo-P1.0`, Beijing only. Use
  `ProviderService.get3DModel(reference?)` to resolve an enabled explicit/default
  model. `doGenerate` submits one of text, single-image or 2–4 distinct views;
  `getTask` queries its status and returns GLB/preview URLs. `uploadImage` supports
  JPEG/PNG via temporary OSS. This is a provider API, not a new agent tool.

Apply `ProviderModel3d1780000041000` before saving/syncing 3D models. Existing
default settings normalize the new `model3dModel` field to null.

All requests use the server's existing network policy and DNS-pinned transport.
Signed media/result URLs and OSS multipart uploads never receive the provider key.
Tests use synthetic responses; the database test uses an isolated temporary schema.

Reference implementation: `aime-chat/src/main/providers/alibaba-provider.ts`
and its sibling adapters. Protocol references:

- https://help.aliyun.com/en/model-studio/qwen-audio-tts-http-api
- https://help.aliyun.com/en/model-studio/qwen-tts-api
- https://help.aliyun.com/en/model-studio/qwen-asr-api-reference
- https://help.aliyun.com/en/model-studio/tripo-3d-generation-api-reference
