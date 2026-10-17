import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  audioMimeType,
  maxReferenceAudioBytes,
  wavMetadata,
} from '../../mastra/providers/audio-data.js';
import { ThreadError } from '../threads/errors.js';

/** Convert uploaded media, never merely rename compressed audio to voice.wav. */
export async function normalizeVoiceAudio(data: Buffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!data.length) throw new ThreadError('AUDIO_INVALID');
  if (data.length > maxReferenceAudioBytes)
    throw new ThreadError('AUDIO_TOO_LARGE', 413);
  try {
    if (audioMimeType(data) === 'audio/wav') {
      wavMetadata(data);
      return data;
    }
  } catch {
    // Also accept browser recordings (WebM) and M4A. Reject playlists and URLs.
    if (
      data.length < 12 ||
      (data.toString('ascii', 4, 8) !== 'ftyp' &&
        data.readUInt32BE(0) !== 0x1a45dfa3)
    )
      throw new ThreadError('AUDIO_INVALID');
  }
  const directory = await mkdtemp(join(tmpdir(), 'voice-audio-'));
  try {
    const source = join(directory, 'input');
    const destination = join(directory, 'voice.wav');
    await writeFile(source, data, { signal });
    await promisify(execFile)(
      'ffmpeg',
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
        '-fs',
        String(maxReferenceAudioBytes + 1),
        destination,
      ],
      { signal, timeout: 60000, maxBuffer: 8192 },
    );
    if ((await stat(destination)).size > maxReferenceAudioBytes)
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
        : 'AUDIO_INVALID',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
