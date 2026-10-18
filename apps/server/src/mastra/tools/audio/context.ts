import type { ToolExecutionContext } from '@mastra/core/tools';
import { CompositeFilesystem, LocalFilesystem } from '@mastra/core/workspace';
import { isAbsolute, relative } from 'node:path';
import type { VoiceStore } from '../../../modules/audio/voices.js';
import { validatePath } from '../../../modules/files/paths.js';
import { maxReferenceAudioBytes } from '../../providers/audio-data.js';
import { requestWebResource } from '../../web/request.js';
import { ThreadError } from '../../../modules/threads/errors.js';

export function audioUser(context?: ToolExecutionContext) {
  const userId = context?.requestContext?.get('userId');
  if (typeof userId === 'string' && userId) return userId;
  if (context?.agent?.resourceId?.startsWith('user:'))
    return context.agent.resourceId.slice(5);
  throw new Error('Audio tools require an authenticated user.');
}

export async function readAudioReference(
  path: string,
  context: ToolExecutionContext | undefined,
  options: {
    voices?: VoiceStore;
    signal: AbortSignal;
    request?: typeof requestWebResource;
    maxBytes?: number;
  },
) {
  options.signal.throwIfAborted();
  const maxBytes = options.maxBytes ?? maxReferenceAudioBytes;
  if (/^https?:\/\//i.test(path)) {
    const response = await (options.request ?? requestWebResource)(path, {
      signal: options.signal,
      maxBytes,
    });
    if (response.status !== 200) throw new Error('Reference download failed');
    return { audio: response.body, text: undefined };
  }
  if (options.voices?.isVoicePath(path))
    return options.voices.readAudio(audioUser(context), path);
  const filesystem = context?.workspace?.filesystem;
  if (!filesystem) throw new Error('A conversation workspace is required.');
  // Chat uploads use virtual /.uploads paths; absolute local paths still have
  // to resolve inside this workspace (including composite project mounts).
  path = path.replace(/^\/(?=\.uploads\/)/, '');
  if (isAbsolute(path) && filesystem instanceof LocalFilesystem)
    path = relative(filesystem.basePath, path);
  else if (
    isAbsolute(path) &&
    filesystem instanceof CompositeFilesystem &&
    filesystem.getMountPathForPath(path)
  )
    path = path.slice(1);
  validatePath(path);
  // The workspace provider enforces containment, including symlink escapes.
  const stat = await filesystem.stat(path);
  if (stat.type !== 'file') throw new ThreadError('AUDIO_INVALID');
  if (stat.size > maxBytes) throw new ThreadError('AUDIO_TOO_LARGE', 413);
  options.signal.throwIfAborted();
  const audio = Buffer.from(await filesystem.readFile(path));
  options.signal.throwIfAborted();
  if (audio.length > maxBytes) throw new ThreadError('AUDIO_TOO_LARGE', 413);
  return { audio, text: undefined };
}
