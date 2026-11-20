import { CompositeFilesystem } from '@mastra/core/workspace';
import type { GroupChatAgent } from '@aime/shared/group-chats';
import {
  listWorkspaceFiles,
  previewWorkspaceFile,
} from '../files/workspace-files.js';
import type { ThreadService } from '../threads/service.js';

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
        const directory =
          root instanceof CompositeFilesystem
            ? '.uploads/.agents/agents'
            : '.agents/agents';
        const listing = await listWorkspaceFiles(root, directory);
        const files = new Set(
          listing.entries
            .filter((entry) => entry.kind === 'file')
            .map((entry) => entry.name),
        );
        const urls: Record<string, string> = {};
        await Promise.all(
          agents.map(async ({ id }) => {
            for (const extension of ['png', 'jpg', 'gif']) {
              const name = `${id}.${extension}`;
              if (!listing.truncated && !files.has(name)) continue;
              const path = `${directory}/${name}`;
              // Files may be removed or replaced while the room is being viewed.
              const info = await previewWorkspaceFile(root, path).catch(
                () => undefined,
              );
              if (!info?.size) continue;
              const query = new URLSearchParams({ path, v: info.modifiedAt });
              urls[id] =
                `/api/threads/${encodeURIComponent(bot.threadId)}/files/raw?${query}`;
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
