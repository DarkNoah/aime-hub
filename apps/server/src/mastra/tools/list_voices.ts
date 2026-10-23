import { BuiltinTool, type ToolSettings } from '../../modules/tools/base.js';
import type { ToolDependencies } from '../../modules/tools/types.js';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { voiceSchema } from '@aime/shared/audio';
import type { VoiceStore } from '../../modules/audio/voices.js';
import { audioUser } from './audio/context.js';

export function createListVoicesTool(voices?: VoiceStore) {
  return createTool({
    id: 'list_voices',
    description:
      'List the current user’s saved and shared voice samples, including id, name, description and transcript. Pass id as speech.voice to reuse a voice without paths or transcripts. Shared status is derived from its filesystem location.',
    inputSchema: z.object({}),
    outputSchema: z.object({
      ok: z.boolean(),
      isError: z.boolean().optional(),
      voices: z.array(voiceSchema),
      error: z.string().optional(),
    }),
    execute: async (_input, context) => {
      try {
        context?.abortSignal?.throwIfAborted();
        if (!voices) throw new Error('Voice store unavailable');
        return { ok: true, voices: await voices.list(audioUser(context)) };
      } catch {
        return {
          ok: false,
          isError: true,
          voices: [],
          error: 'Could not list voices for the current user.',
        };
      }
    },
  });
}
export const listVoices = createListVoicesTool();

export class ListVoicesTool extends BuiltinTool<'builtin'> {
  constructor() {
    super(listVoices, 'builtin');
  }

  protected override create(
    _config: ToolSettings<'builtin'>,
    dependencies: ToolDependencies,
  ) {
    return createListVoicesTool(dependencies.audio?.voices);
  }
}
