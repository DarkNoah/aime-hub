import { speechMediaTypes, type SpeechFormat } from '@aime/shared/audio';
import { readFileBlocks } from './read-file-output.js';

export function parseSpeechOutput(output: unknown, threadId?: string) {
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output) as unknown;
    } catch {
      return null;
    }
  }
  if (!output || typeof output !== 'object' || Array.isArray(output))
    return null;
  const record = output as Record<string, unknown>;
  const path =
    typeof record.file_path === 'string' ? record.file_path : undefined;
  if (
    path?.trim() &&
    typeof record.duration === 'number' &&
    Number.isFinite(record.duration) &&
    record.duration > 0 &&
    typeof record.sample_rate === 'number' &&
    Number.isFinite(record.sample_rate) &&
    record.sample_rate > 0 &&
    record.ok !== false &&
    record.isError !== true
  ) {
    return {
      path,
      model: undefined,
      sampleRate: record.sample_rate,
      audio:
        threadId && !path.toLowerCase().endsWith('.pcm')
          ? readFileBlocks({
              type: 'file',
              url: `/api/threads/${encodeURIComponent(threadId)}/files/raw?${new URLSearchParams({ path })}`,
              mimeType:
                speechMediaTypes[
                  path.split('.').at(-1)?.toLowerCase() as SpeechFormat
                ] ?? 'audio/wav',
              filename: path,
            })
          : [],
      failed: false,
      message: '',
    };
  }
  // Keep historical tool results playable after the output format changes.
  if (typeof record.ok !== 'boolean' || !Array.isArray(record.content))
    return null;
  const blocks = readFileBlocks(output, path);
  const audio = blocks.filter(
    (block) => block.type === 'media' && block.mediaType.startsWith('audio/'),
  );
  const failed = !record.ok || record.isError === true;
  const text = blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
  return {
    path,
    model: typeof record.model === 'string' ? record.model : undefined,
    sampleRate:
      typeof record.sampleRate === 'number' &&
      Number.isFinite(record.sampleRate) &&
      record.sampleRate > 0
        ? record.sampleRate
        : undefined,
    audio,
    failed,
    // The player already presents the saved file and audio metadata.
    message:
      !failed && audio.length > 0
        ? text.replace(/^Speech saved to [^\n]*(?:\n|$)/, '').trim()
        : text,
  };
}
