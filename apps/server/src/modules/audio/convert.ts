import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  audioMimeType,
  maxReferenceAudioBytes,
  wavMetadata,
} from '../../mastra/providers/audio-data.js';
import { ThreadError } from '../threads/errors.js';
import { ffmpegPath } from './binaries.js';

/** Convert uploaded media, never merely rename compressed audio to voice.wav. */
export function normalizeVoiceAudio(data: Buffer, signal?: AbortSignal) {
  return normalizeAudio(data, signal, {
    maxBytes: maxReferenceAudioBytes,
    timeoutMs: 60000,
  });
}

/** Transcribe the complete first audio track without imposing voice-sample limits. */
export function normalizeTranscriptionAudio(
  data: Buffer,
  signal?: AbortSignal,
) {
  return normalizeAudio(data, signal);
}

async function normalizeAudio(
  data: Buffer,
  signal?: AbortSignal,
  options: { maxBytes?: number; timeoutMs?: number } = {},
) {
  const maxBytes = options.maxBytes ?? Infinity;
  signal?.throwIfAborted();
  if (!data.length) throw new ThreadError('AUDIO_INVALID');
  if (data.length > maxBytes) throw new ThreadError('AUDIO_TOO_LARGE', 413);
  let mimeType: ReturnType<typeof audioMimeType> | undefined;
  try {
    // Sniff the header independently of the smaller reference-audio size limit.
    mimeType = audioMimeType(data.subarray(0, 12));
  } catch {
    // MP4/MOV/M4A, WebM/MKV and AVI containers. Keep playlists and URLs out
    // of ffmpeg; remote media must be fetched through the validated reader.
    if (
      data.length < 12 ||
      (data.toString('ascii', 4, 8) !== 'ftyp' &&
        data.readUInt32BE(0) !== 0x1a45dfa3 &&
        !(
          data.toString('ascii', 0, 4) === 'RIFF' &&
          data.toString('ascii', 8, 12) === 'AVI '
        ))
    )
      throw new ThreadError('AUDIO_INVALID');
  }
  if (mimeType === 'audio/wav') {
    try {
      wavMetadata(data);
      return data;
    } catch {
      throw new ThreadError('AUDIO_INVALID');
    }
  }
  if (!ffmpegPath) throw new ThreadError('AUDIO_CONVERTER_UNAVAILABLE');
  const directory = await mkdtemp(join(tmpdir(), 'voice-audio-'));
  try {
    const source = join(directory, 'input');
    const destination = join(directory, 'voice.wav');
    await writeFile(source, data, { signal });
    await runConverter(
      ffmpegPath,
      [
        '-nostdin',
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        source,
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '24000',
        '-c:a',
        'pcm_s16le',
        ...(Number.isFinite(maxBytes) ? ['-fs', String(maxBytes + 1)] : []),
        destination,
      ],
      signal,
      options.timeoutMs,
    );
    if ((await stat(destination)).size > maxBytes)
      throw new ThreadError('AUDIO_TOO_LARGE', 413);
    const wav = await readFile(destination, { signal });
    wavMetadata(wav);
    return wav;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ThreadError) throw error;
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    throw new ThreadError(
      failure.code === 'ENOENT' ||
        /Library not loaded|error while loading shared libraries/.test(
          failure.stderr ?? '',
        )
        ? 'AUDIO_CONVERTER_UNAVAILABLE'
        : /Stream map .*matches no streams/.test(failure.stderr ?? '')
          ? 'AUDIO_TRACK_MISSING'
          : 'AUDIO_INVALID',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Wait for the process to exit before removing files, including after abort. */
function runConverter(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs?: number,
) {
  return new Promise<void>((resolve, reject) => {
    let failure: (Error & { stderr?: string }) | undefined;
    const child = execFile(
      command,
      args,
      { signal, timeout: timeoutMs, maxBuffer: 8192, killSignal: 'SIGKILL' },
      (error, _stdout, stderr) => {
        if (error) failure = Object.assign(error, { stderr });
      },
    );
    child.once('close', () => (failure ? reject(failure) : resolve()));
  });
}
