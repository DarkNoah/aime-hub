type Family = 'audio' | 'cosy' | 'qwen' | 'minimax';
type SpeechModel = {
  id: string;
  name: string;
  family: Family;
  regions: string[];
  defaultVoice?: string;
};
const beijing = ['cn-beijing'];
const international = ['cn-beijing', 'ap-southeast-1'];

export const ALIBABA_SPEECH_MODELS: SpeechModel[] = [
  ...['plus', 'flash'].map((tier): SpeechModel => ({
    id: `qwen-audio-3.0-tts-${tier}`,
    name: `Qwen Audio 3.0 TTS ${tier}`,
    family: 'audio',
    regions: beijing,
    defaultVoice: 'longanhuan_v3.6',
  })),
  ...['v3.5-plus', 'v3.5-flash', 'v3-plus', 'v3-flash', 'v2'].map(
    (version): SpeechModel => ({
      id: `cosyvoice-${version}`,
      name: `CosyVoice ${version}${version.startsWith('v3.5') ? ' (custom voice)' : ''}`,
      family: 'cosy',
      regions: beijing,
      defaultVoice: {
        'v3-plus': 'longanyang',
        'v3-flash': 'longanyang',
        v2: 'longxiaochun_v2',
      }[version],
    }),
  ),
  ...[
    ['qwen3-tts-instruct-flash', 'Qwen3 TTS Instruct Flash', 'Cherry'],
    ['qwen3-tts-flash', 'Qwen3 TTS Flash', 'Cherry'],
    ['qwen3-tts-vd-2026-01-26', 'Qwen3 TTS Voice Design (custom voice)'],
    ['qwen3-tts-vc-2026-01-22', 'Qwen3 TTS Voice Clone (custom voice)'],
  ].map(([id, name, defaultVoice]): SpeechModel => ({
    id,
    name,
    defaultVoice,
    family: 'qwen',
    regions: international,
  })),
  ...['2.8-hd', '2.8-turbo', '02-hd', '02-turbo'].map(
    (version): SpeechModel => ({
      id: `MiniMax/speech-${version}`,
      name: `MiniMax Speech ${version}`,
      family: 'minimax',
      regions: beijing,
      defaultVoice: 'male-qn-qingse',
    }),
  ),
];

type Mode = 'async' | 'flash' | 'qwen-flash';
const commonRegions = ['cn-beijing', 'ap-southeast-1'];
export const ALIBABA_TRANSCRIPTION_MODELS: Array<{
  id: string;
  name: string;
  mode: Mode;
  regions: string[];
}> = [
  {
    id: 'qwen-audio-3.0-asr-flash-filetrans',
    name: 'Qwen Audio 3.0 ASR Filetrans',
    mode: 'async',
    regions: commonRegions,
  },
  {
    id: 'qwen-audio-3.0-asr-flash',
    name: 'Qwen Audio 3.0 ASR Flash',
    mode: 'flash',
    regions: commonRegions,
  },
  { id: 'fun-asr', name: 'Fun ASR', mode: 'async', regions: commonRegions },
  {
    id: 'fun-asr-mtl',
    name: 'Fun ASR Multilingual',
    mode: 'async',
    regions: commonRegions,
  },
  {
    id: 'fun-asr-flash-2026-06-15',
    name: 'Fun ASR Flash',
    mode: 'flash',
    regions: commonRegions,
  },
  {
    id: 'qwen3-asr-flash-filetrans',
    name: 'Qwen3 ASR Flash Filetrans',
    mode: 'async',
    regions: commonRegions,
  },
  {
    id: 'qwen3-asr-flash',
    name: 'Qwen3 ASR Flash (text only)',
    mode: 'qwen-flash',
    regions: commonRegions,
  },
  {
    id: 'qwen3-asr-flash-us',
    name: 'Qwen3 ASR Flash US (text only)',
    mode: 'qwen-flash',
    regions: ['us-east-1'],
  },
  {
    id: 'paraformer-v2',
    name: 'Paraformer V2',
    mode: 'async',
    regions: ['cn-beijing'],
  },
  {
    id: 'paraformer-mtl-v1',
    name: 'Paraformer Multilingual V1',
    mode: 'async',
    regions: ['cn-beijing'],
  },
];

export const ALIBABA_3D_MODELS = [
  { id: 'Tripo/Tripo-H3.1', name: 'Tripo H3.1' },
  { id: 'Tripo/Tripo-P1.0', name: 'Tripo P1.0' },
];
