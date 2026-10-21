import type { GroupChatMessage, MemberProfile } from '@aime/shared/group-chats';
import { api, apiErrorCode } from '@/lib/rpc';

export const groupChatApi = {
  openDefault: (projectId?: string, signal?: AbortSignal) =>
    api.groupChats.openDefault({ body: { projectId } }, { signal }),
  get: (roomId: string, signal?: AbortSignal) =>
    api.groupChats.get({ params: { roomId } }, { signal }),
  messages: (
    roomId: string,
    query: { before?: string; after?: string } = {},
    signal?: AbortSignal,
  ) =>
    api.groupChats.messages(
      { params: { roomId }, query: { ...query, limit: 50 } },
      { signal },
    ),
  send: (roomId: string, id: string, text: string) =>
    api.groupChats.send({ params: { roomId }, body: { id, text } }),
};

export async function lookupMembers(
  userIds: string[],
  roomId: string,
  signal?: AbortSignal,
): Promise<MemberProfile[]> {
  const ids = [...new Set(userIds)];
  const batches: Promise<MemberProfile[]>[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    batches.push(
      api.users.lookup(
        { body: { userIds: ids.slice(index, index + 100), roomId } },
        { signal },
      ),
    );
  }
  return (await Promise.all(batches)).flat();
}

export function mergeMessages(
  previous: GroupChatMessage[],
  incoming: GroupChatMessage[],
) {
  const byId = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) =>
    BigInt(a.sequence) < BigInt(b.sequence)
      ? -1
      : BigInt(a.sequence) > BigInt(b.sequence)
        ? 1
        : 0,
  );
}

export type GroupChatErrorKey =
  'groupChat.unavailable' | 'groupChat.invalid' | 'groupChat.failed';

export function groupChatErrorKey(error: unknown): GroupChatErrorKey {
  switch (apiErrorCode(error)) {
    case 'NOT_FOUND':
    case 'FORBIDDEN':
      return 'groupChat.unavailable';
    case 'UNAUTHORIZED':
      return 'groupChat.unavailable';
    case 'VALIDATION_ERROR':
      return 'groupChat.invalid';
    default:
      return 'groupChat.failed';
  }
}
