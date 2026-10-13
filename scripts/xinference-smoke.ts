import { readFile, writeFile } from 'node:fs/promises';
import {
  embedMany,
  rerank,
  experimental_generateSpeech as generateSpeech,
} from 'ai';
import { XinferenceProvider } from '../apps/server/src/mastra/providers/xinference.js';

// Explicit opt-in live check. Credentials are read at runtime and never printed.
const config = process.env.XINFERENCE_CONFIG_FILE
  ? (JSON.parse(await readFile(process.env.XINFERENCE_CONFIG_FILE, 'utf8')) as {
      baseUrl: string;
      apiKey?: string;
    })
  : {
      baseUrl: process.env.XINFERENCE_BASE_URL,
      apiKey: process.env.XINFERENCE_API_KEY,
    };
if (!config.baseUrl)
  throw new Error('Set XINFERENCE_BASE_URL or XINFERENCE_CONFIG_FILE');
const provider = new XinferenceProvider({
  ...config,
  baseUrl: config.baseUrl,
  id: 'xinference-smoke',
  timeoutMs: 300_000,
});
const models = await provider.getModelList();
console.log(
  JSON.stringify({
    models: models.map(({ id, modelType }) => ({ id, modelType })),
  }),
);
const speech =
  process.env.XINFERENCE_SPEECH_MODEL ??
  models.find((model) => model.modelType === 'speech')?.id;
if (!speech) throw new Error('No speech model available');
const started = Date.now();
const reference = process.env.XINFERENCE_REFERENCE_AUDIO;
const result = await generateSpeech({
  model: provider.speechModel(speech),
  text:
    process.env.XINFERENCE_SPEECH_TEXT ?? '你好，这是语音合成接口的真实测试。',
  speed: 1,
  maxRetries: 0,
  providerOptions: {
    xinference: {
      ...(reference
        ? {
            promptSpeech: (await readFile(reference)).toString('base64'),
            promptSpeechMediaType:
              process.env.XINFERENCE_REFERENCE_MEDIA_TYPE ?? 'audio/wav',
          }
        : {}),
      kwargs: {
        seed: 42,
        ...(process.env.XINFERENCE_PROMPT_TEXT
          ? { prompt_text: process.env.XINFERENCE_PROMPT_TEXT }
          : {}),
      },
    },
  },
});
const output =
  process.env.XINFERENCE_SPEECH_OUTPUT ?? '/tmp/xinference-speech.wav';
await writeFile(output, result.audio.uint8Array);
console.log(
  JSON.stringify({
    speech: {
      model: speech,
      output,
      bytes: result.audio.uint8Array.length,
      mediaType: result.audio.mediaType,
      elapsedMs: Date.now() - started,
    },
  }),
);

if (process.env.XINFERENCE_TEST_ALL === '1') {
  const embedding = models.find((model) => model.modelType === 'embedding');
  if (embedding) {
    const result = await embedMany({
      model: provider.embeddingModel(embedding.id),
      values: ['你好', '模型接入测试'],
      maxRetries: 0,
    });
    console.log(
      JSON.stringify({
        embedding: {
          model: embedding.id,
          count: result.embeddings.length,
          dimensions: result.embeddings[0]?.length,
        },
      }),
    );
  }
  const ranking = models.find((model) => model.modelType === 'rerank');
  if (ranking) {
    const result = await rerank({
      model: provider.rerankingModel(ranking.id),
      query: '中国的首都',
      documents: ['北京是中国的首都。', '苹果是一种水果。'],
      topN: 1,
      maxRetries: 0,
    });
    console.log(
      JSON.stringify({
        rerank: { model: ranking.id, ranking: result.ranking },
      }),
    );
  }
}
