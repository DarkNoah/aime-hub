import { normalizeTranscriptionAudio } from '../audio/convert.js';
import { loadToolSettings } from './base.js';
import type { ToolDefaultConfigs, ToolDependencies } from './types.js';

/** read_file and extract share the saved ASR selection and audio normalization. */
export function fileTranscriber(
  defaults: ToolDefaultConfigs,
  dependencies: ToolDependencies,
) {
  const audio = dependencies.audio;
  return audio
    ? async (data: Buffer, signal: AbortSignal) => {
        const settings = await loadToolSettings(
          'transcriptions',
          'transcriptions',
          defaults,
          dependencies,
        );
        signal.throwIfAborted();
        const bytes = await normalizeTranscriptionAudio(data, signal);
        const result = await audio.transcriptions(bytes, {
          response_format: 'json',
          signal,
          model: settings.model ?? undefined,
        });
        return typeof result === 'string' ? result : result.text;
      }
    : undefined;
}
