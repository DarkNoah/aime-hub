import type { OfflineRecognizer } from '@sherpaw/asr';
import type { CircularBuffer, VadInstance } from '@sherpaw/vad';
import { loadSpeechModel, senseVoiceModels } from './sensevoice-models';
import type {
  SenseVoiceRequest,
  SenseVoiceResponse,
} from './speech-input-types';

let recognizer: OfflineRecognizer | undefined;
let vad: VadInstance | undefined;
let history: CircularBuffer | undefined;
let previousEnd = 0;
const historyCapacity = 16000 * 30;
let line = 0;
let failed = false;
const send = (message: SenseVoiceResponse) => self.postMessage(message);

async function load(runtimeBase: string) {
  const [asr, voiceActivity] = await Promise.all([
    import(/* @vite-ignore */ `${runtimeBase}asr/index.js`) as Promise<
      typeof import('@sherpaw/asr')
    >,
    import(/* @vite-ignore */ `${runtimeBase}vad/index.js`) as Promise<
      typeof import('@sherpaw/vad')
    >,
  ]);
  const progress = new Map<string, { loaded: number; total?: number }>();
  const download = (url: string) =>
    loadSpeechModel(url, (value) => {
      progress.set(url, value);
      const values = [...progress.values()];
      send({
        type: 'progress',
        progress: {
          loaded: values.reduce((sum, item) => sum + item.loaded, 0),
          total:
            values.length === 3 && values.every((item) => item.total)
              ? values.reduce((sum, item) => sum + item.total!, 0)
              : undefined,
        },
      });
    });
  const [asrModule, vadModule, model, tokens, vadModel] = await Promise.all([
    asr.initASRModule(),
    voiceActivity.initVADModule(),
    download(senseVoiceModels.model),
    download(senseVoiceModels.tokens),
    download(senseVoiceModels.vad),
  ]);
  asrModule.FS_createDataFile('/', 'model.onnx', model, true, false, true);
  asrModule.FS_createDataFile('/', 'tokens.txt', tokens, true, false, true);
  vadModule.FS_createDataFile(
    '/',
    'silero_vad.onnx',
    vadModel,
    true,
    false,
    true,
  );
  recognizer = new asr.OfflineRecognizer(
    {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: '/model.onnx',
          language: 'auto',
          useInverseTextNormalization: 1,
        },
        tokens: '/tokens.txt',
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
    },
    asrModule,
  );
  if (!recognizer.handle)
    throw new Error('Could not initialize SenseVoiceSmall');
  vad = voiceActivity.createVad(vadModule, {
    sileroVad: {
      model: '/silero_vad.onnx',
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      windowSize: 512,
      maxSpeechDuration: 10,
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 30,
  });
  if (!vad.handle) throw new Error('Could not initialize speech detection');
  history = new voiceActivity.CircularBuffer(historyCapacity, vadModule);
  // Inference sessions own the loaded weights now; release virtual file copies.
  asrModule.FS_unlink?.('/model.onnx');
  asrModule.FS_unlink?.('/tokens.txt');
  vadModule.FS_unlink?.('/silero_vad.onnx');
  send({ type: 'ready' });
}

function decodeSegments() {
  while (vad && recognizer && history && !vad.isEmpty()) {
    const segment = vad.front();
    vad.pop();
    // VAD can place the boundary inside a quiet initial consonant. Retain a
    // short lead-in without repeating audio from the preceding sentence.
    const start = Math.max(history.head(), previousEnd, segment.start - 4800);
    const end = segment.start + segment.samples.length;
    const samples = history.get(start, end - start);
    previousEnd = end;
    const stream = recognizer.createStream();
    try {
      stream.acceptWaveform(16000, samples);
      recognizer.decode(stream);
      const result = recognizer.getResult(stream) as { text?: string };
      const text = result.text?.replace(/<\|[^|]*\|>/g, '').trim();
      if (text) send({ type: 'line', id: String(line++), text });
    } finally {
      stream.free();
    }
  }
}

function acceptAudio(samples: Float32Array) {
  if (!vad || !history) throw new Error('Speech model is not ready');
  const overflow = history.size() + samples.length - historyCapacity;
  if (overflow > 0) history.pop(overflow);
  history.push(samples);
  vad.acceptWaveform(samples);
}

self.onmessage = async (event: MessageEvent<SenseVoiceRequest>) => {
  if (failed) return;
  try {
    const request = event.data;
    if (request.type === 'load') {
      await load(request.runtimeBase);
      return;
    }
    if (!vad || !recognizer) throw new Error('Speech model is not ready');
    if (request.type === 'audio') {
      acceptAudio(request.samples);
      decodeSegments();
      send({ type: 'accepted', samples: request.samples.length });
    } else {
      // Complete the VAD's last window, including speech ending at the stop click.
      acceptAudio(new Float32Array(512));
      vad.flush();
      decodeSegments();
      send({ type: 'finished' });
    }
  } catch (error) {
    failed = true;
    send({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
