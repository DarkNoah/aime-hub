import { posix, resolve } from 'node:path';
import {
  CompositeFilesystem,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
import type { GroupChatThreadBinding } from './metadata.js';

/** Keep the injected disk file and the agent's writable path on the same storage. */
export function groupChatMemoryLocation(
  workingDirectory: string,
  binding: Pick<GroupChatThreadBinding, 'roomId' | 'memberId'>,
  filesystem: WorkspaceFilesystem | undefined,
): { directory: string; filePath: string } {
  const { roomId, memberId } = binding;
  if (filesystem instanceof CompositeFilesystem) {
    // Every project composite includes this contained local mount, even when
    // its user-configured data mounts are read-only or use AgentFS.
    return {
      directory: resolve(
        workingDirectory,
        '.uploads',
        '.group-chats',
        roomId,
        memberId,
      ),
      filePath: posix.join(
        '/.uploads',
        '.group-chats',
        roomId,
        memberId,
        'MEMORY.md',
      ),
    };
  }
  const directory = resolve(
    workingDirectory,
    '.agents',
    'group-chats',
    roomId,
    memberId,
  );
  return { directory, filePath: resolve(directory, 'MEMORY.md') };
}
