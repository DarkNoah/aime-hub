import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CompositeFilesystem,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
import type { GroupChatAgent } from '@aime/shared/group-chats';
import {
  listWorkspaceFiles,
  previewWorkspaceFile,
  resolveWorkspaceTarget,
} from '../files/workspace-files.js';
import { ensureWorkspaceDirectory, filePath } from '../files/paths.js';
import { withFileLock } from '../files/service.js';
import { ThreadError } from '../threads/errors.js';
import type { ThreadService } from '../threads/service.js';

function avatarDirectory(root: string | WorkspaceFilesystem) {
  return root instanceof CompositeFilesystem
    ? '.uploads/.agents/agents'
    : '.agents/agents';
}

function avatarUrl(threadId: string, path: string, modifiedAt: string) {
  const query = new URLSearchParams({ path, v: modifiedAt });
  return `/api/threads/${encodeURIComponent(threadId)}/files/raw?${query}`;
}

export async function saveRoomAgentAvatar(
  root: string | WorkspaceFilesystem,
  threadId: string,
  agentId: string,
  image: Buffer,
  signal?: AbortSignal,
) {
  const directory = avatarDirectory(root);
  const target = resolveWorkspaceTarget(root, directory);
  const disk = target.root;
  if (typeof disk !== 'string')
    throw new ThreadError('WORKSPACE_UNAVAILABLE', 404);
  const name = `${agentId}.webp`;
  const path = `${directory}/${name}`;
  return withFileLock(disk, async () => {
    signal?.throwIfAborted();
    const parent = await ensureWorkspaceDirectory(disk, target.path);
    const temporary = join(parent, `.avatar-${randomUUID()}`);
    try {
      await writeFile(temporary, image, { flag: 'wx', signal });
      await filePath(disk, target.path);
      signal?.throwIfAborted();
      // Renaming a complete sibling also replaces a final symlink without following it.
      await rename(temporary, join(parent, name));
      const info = await previewWorkspaceFile(root, path);
      return { url: avatarUrl(threadId, path, info.modifiedAt) };
    } finally {
      await rm(temporary, { force: true });
    }
  });
}

export async function getRoomAgentAvatarUrls(
  threads: Pick<ThreadService, 'withWorkspaceFiles'>,
  userId: string,
  agents: readonly Pick<GroupChatAgent, 'id' | 'threadId' | 'role'>[],
): Promise<Record<string, string>> {
  const bot = agents.find((agent) => agent.role === 'bot');
  if (!bot) return {};
  try {
    return await threads.withWorkspaceFiles(
      userId,
      bot.threadId,
      async (root) => {
        const directory = avatarDirectory(root);
        const listing = await listWorkspaceFiles(root, directory);
        const files = new Set(
          listing.entries
            .filter((entry) => entry.kind === 'file')
            .map((entry) => entry.name),
        );
        const urls: Record<string, string> = {};
        await Promise.all(
          agents.map(async ({ id }) => {
            for (const extension of ['webp', 'png', 'jpg', 'gif']) {
              const name = `${id}.${extension}`;
              if (!listing.truncated && !files.has(name)) continue;
              const path = `${directory}/${name}`;
              // Files may be removed or replaced while the room is being viewed.
              const info = await previewWorkspaceFile(root, path).catch(
                () => undefined,
              );
              if (!info?.size) continue;
              urls[id] = avatarUrl(bot.threadId, path, info.modifiedAt);
              break;
            }
          }),
        );
        return urls;
      },
    );
  } catch {
    // Avatars are optional, including when the directory or workspace is unavailable.
    return {};
  }
}
