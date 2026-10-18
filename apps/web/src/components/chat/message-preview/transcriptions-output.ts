import {
  transcriptionCancellationMessage,
  transcriptionFormats,
  transcriptionExcerpt,
  type TranscriptionFormat,
} from '@aime/shared/audio';

type Cue = { start: number; end: number; text: string };
export type TranscriptionsResult = {
  format: TranscriptionFormat;
  text: string;
  cues: Cue[];
  language?: string;
  duration?: number;
  failed: boolean;
  message?: string;
  truncated?: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function seconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function timestamp(value: string) {
  if (!/^(?:\d{2,}:)?[0-5]\d:[0-5]\d[.,]\d{3}$/.test(value)) return null;
  return value
    .replace(',', '.')
    .split(':')
    .reduce((time, part) => time * 60 + Number(part), 0);
}

function subtitleCues(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[\t ]*\n/)) {
    if (
      !block.trim() ||
      /^(WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)
    )
      continue;
    const lines = block.split('\n');
    const index = lines.findIndex((line) => line.includes('-->'));
    const match =
      index >= 0 && index <= 1
        ? lines[index].match(/^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/)
        : null;
    if (!match) return [];
    const start = timestamp(match[1]);
    const end = timestamp(match[2]);
    if (start === null || end === null || end < start) return [];
    cues.push({
      start,
      end,
      text: lines
        .slice(index + 1)
        .join('\n')
        .trim(),
    });
  }
  return cues;
}

/** Display excerpts only; do not mutate persisted responses or saved files. */
export function parseTranscriptionsOutput(
  output: unknown,
  requestedFormat?: unknown,
): TranscriptionsResult | null {
  // Let the generic output renderer display cancellation as plain text.
  if (output === transcriptionCancellationMessage) return null;
  const format = transcriptionFormats.find(
    (value) => value === requestedFormat,
  );
  if (typeof output === 'string') {
    // Explicit text may itself contain JSON. Never reinterpret that transcript.
    if (!format || format === 'json' || format === 'verbose_json') {
      try {
        const parsed: unknown = JSON.parse(output);
        if (record(parsed)) return parseTranscriptionsOutput(parsed, format);
      } catch {
        /* Historical tool results may be plain text. */
      }
      if (format === 'json' || format === 'verbose_json') return null;
    }
    const resolvedFormat =
      format ?? (output.startsWith('WEBVTT') ? 'vtt' : 'text');
    const excerpt = transcriptionExcerpt(output);
    if (excerpt.truncated)
      return {
        format: resolvedFormat,
        text: excerpt.text,
        cues: [],
        failed: false,
        truncated: true,
      };
    const cues =
      resolvedFormat === 'srt' || resolvedFormat === 'vtt'
        ? subtitleCues(output)
        : [];
    return {
      format: resolvedFormat,
      text: cues.length ? cues.map((cue) => cue.text).join('\n') : output,
      cues,
      failed: false,
    };
  }
  const data = record(output);
  if (!data) return null;
  const failed = data.isError === true || data.ok === false;
  if (failed) {
    const message = [
      data.message,
      data.error,
      record(data.error)?.message,
      data.text,
    ].find((value) => typeof value === 'string' && value.trim());
    return {
      format: format ?? 'json',
      text: '',
      cues: [],
      failed,
      message: typeof message === 'string' ? message : undefined,
    };
  }
  if (typeof data.text !== 'string') return null;
  const excerpt = transcriptionExcerpt(data);
  const cues =
    !excerpt.truncated && Array.isArray(data.segments)
      ? data.segments.flatMap((item): Cue[] => {
          const segment = record(item);
          if (!segment || typeof segment.text !== 'string') return [];
          const start = segment.start ?? segment.startSecond;
          const end = segment.end ?? segment.endSecond;
          return seconds(start) && seconds(end) && end >= start
            ? [{ start, end, text: segment.text }]
            : [];
        })
      : [];
  return {
    format:
      format ??
      (data.segments || data.duration !== undefined ? 'verbose_json' : 'json'),
    text: excerpt.truncated ? excerpt.text : data.text,
    cues,
    truncated: excerpt.truncated,
    language:
      typeof data.language === 'string' && data.language.trim()
        ? data.language
        : undefined,
    duration: seconds(data.duration) ? data.duration : undefined,
    failed: false,
  };
}

export function transcriptionTimestamp(seconds: number) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const remainder = Math.floor(milliseconds / 1000) % 60;
  const fraction = milliseconds % 1000;
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}${fraction ? `.${String(fraction).padStart(3, '0')}` : ''}`;
}
