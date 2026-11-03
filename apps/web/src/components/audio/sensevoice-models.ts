import type { SpeechProgress } from './speech-input-types';

// Official sherpa-onnx conversion of iic/SenseVoiceSmall, pinned to one revision.
const modelBase =
  'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07';
export const senseVoiceModels = {
  model: `${modelBase}/model.int8.onnx`,
  tokens: `${modelBase}/tokens.txt`,
  vad: 'https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx',
};

export async function loadSpeechModel(
  url: string,
  onProgress: (progress: SpeechProgress) => void,
) {
  // Private browsing/storage quotas must not prevent recognition.
  const cache = await globalThis.caches
    ?.open('sensevoice-small-v1')
    .catch(() => undefined);
  const cached = await cache?.match(url).catch(() => undefined);
  const response = cached ?? (await fetch(url));
  if (!response.ok)
    throw new Error(`Speech model download failed (${response.status})`);
  const total = Number(response.headers.get('content-length')) || undefined;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Speech model download has no body');
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({ loaded, total });
  }
  if (!loaded) throw new Error('Speech model download is empty');
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  chunks.length = 0;
  if (!cached) {
    await cache
      ?.put(
        url,
        new Response(bytes, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(loaded),
          },
        }),
      )
      .catch(() => {});
  }
  onProgress({ loaded, total: loaded });
  return bytes;
}
