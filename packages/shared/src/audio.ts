import { z } from 'zod';

export const speechFormats = [
  'mp3',
  'opus',
  'aac',
  'flac',
  'wav',
  'pcm',
] as const;
export type SpeechFormat = (typeof speechFormats)[number];
export const speechMediaTypes: Record<SpeechFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'application/octet-stream',
};

const speechEventBase = z.object({
  playbackId: z.string(),
  toolCallId: z.string().optional(),
  text: z.string(),
  sequence: z.number().int().nonnegative(),
});
export const speechEventSchema = z.discriminatedUnion('phase', [
  speechEventBase.extend({ phase: z.literal('start') }),
  speechEventBase.extend({
    phase: z.literal('chunk'),
    audio: z.string().max(65536),
    encoding: z.enum(['pcm_s16le', 'file']),
    mimeType: z.string(),
    sampleRate: z.number().int().positive().optional(),
    channels: z.number().int().positive().optional(),
  }),
  speechEventBase.extend({ phase: z.literal('end') }),
  speechEventBase.extend({ phase: z.literal('cancelled') }),
  speechEventBase.extend({
    phase: z.literal('error'),
    error: z.enum(['GENERATION_FAILED', 'TIMED_OUT']),
  }),
]);
export type SpeechEvent = z.infer<typeof speechEventSchema>;

export const voiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  audioPath: z.string(),
  textPath: z.string(),
  text: z.string(),
  shared: z.boolean(),
  canEdit: z.boolean(),
});
export type Voice = z.infer<typeof voiceSchema>;

export const createVoiceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).default(''),
  text: z.string().trim().min(1).max(32000),
  shared: z.boolean().default(false),
});
export const generateVoiceSchema = createVoiceSchema.extend({
  model: z.string().optional(),
  voice: z.string().optional(),
  instructions: z.string().optional(),
  language: z.string().optional(),
});
export type GenerateVoiceInput = z.input<typeof generateVoiceSchema>;
export const updateVoiceSchema = z.object({
  audioPath: z.string(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).default(''),
  text: z.string().trim().min(1).max(32000),
  shared: z.boolean(),
});
export type UpdateVoiceInput = z.infer<typeof updateVoiceSchema>;
