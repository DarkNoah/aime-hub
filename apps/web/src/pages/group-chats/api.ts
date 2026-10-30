import type {
  GroupChatMessage,
  MemberProfile,
  GroupChatAgentInput,
  GroupChatAgentUpdate,
  GroupChatA2AMemberInput,
  GroupChatA2AMemberUpdate,
  GroupChatFile,
} from '@aime/shared/group-chats';
import { api, apiErrorCode } from '@/lib/rpc';

export const groupChatApi = {
  unread: (signal?: AbortSignal) => api.groupChats.unread({}, { signal }),
  markRead: (roomId: string, sequence: string, signal?: AbortSignal) =>
    api.groupChats.markRead(
      { params: { roomId }, body: { sequence } },
      { signal },
    ),
  list: (page = 0, signal?: AbortSignal) =>
    api.groupChats.list({ query: { page, perPage: 50 } }, { signal }),
  openDefault: (projectId?: string, signal?: AbortSignal) =>
    api.groupChats.openDefault({ body: { projectId } }, { signal }),
  get: (roomId: string, signal?: AbortSignal) =>
    api.groupChats.get({ params: { roomId } }, { signal }),
  searchUsers: (roomId: string, query: string, signal?: AbortSignal) =>
    api.groupChats.searchUsers(
      { params: { roomId }, query: { query } },
      { signal },
    ),
  addMember: (roomId: string, userId: string) =>
    api.groupChats.addMember({ params: { roomId }, body: { userId } }),
  createA2aMember: (roomId: string, body: GroupChatA2AMemberInput) =>
    api.groupChats.createA2aMember({ params: { roomId }, body }),
  updateA2aMember: (
    roomId: string,
    memberId: string,
    body: GroupChatA2AMemberUpdate,
  ) => api.groupChats.updateA2aMember({ params: { roomId, memberId }, body }),
  revokeA2aMember: (roomId: string, memberId: string) =>
    api.groupChats.revokeA2aMember({ params: { roomId, memberId } }),
  removeA2aMember: (roomId: string, memberId: string) =>
    api.groupChats.removeA2aMember({ params: { roomId, memberId } }),
  messages: (
    roomId: string,
    query: { before?: string; after?: string; afterRevision?: string } = {},
    signal?: AbortSignal,
  ) =>
    api.groupChats.messages(
      { params: { roomId }, query: { ...query, limit: 50 } },
      { signal },
    ),
  send: (
    roomId: string,
    id: string,
    text: string,
    replyToId?: string,
    files?: GroupChatFile[],
  ) =>
    api.groupChats.send({
      params: { roomId },
      body: { id, text, replyToId, ...(files?.length ? { files } : {}) },
    }),
  react: (roomId: string, messageId: string, emoji: string, active: boolean) =>
    api.groupChats.react({
      params: { roomId, messageId },
      body: { emoji, active },
    }),
  respondUi: (
    roomId: string,
    messageId: string,
    id: string,
    data: NonNullable<GroupChatMessage['uiResponse']>['data'],
  ) =>
    api.groupChats.respondUi({
      params: { roomId, messageId },
      body: { id, data },
    }),
  addAgent: (roomId: string, body: GroupChatAgentInput) =>
    api.groupChats.addAgent({ params: { roomId }, body }),
  updateAgent: (roomId: string, agentId: string, body: GroupChatAgentUpdate) =>
    api.groupChats.updateAgent({ params: { roomId, agentId }, body }),
  removeAgent: (roomId: string, agentId: string) =>
    api.groupChats.removeAgent({ params: { roomId, agentId } }),
  plans: (roomId: string, signal?: AbortSignal) =>
    api.groupChats.plans({ params: { roomId } }, { signal }),
  cancelPlan: (roomId: string, planId: string) =>
    api.groupChats.cancelPlan({ params: { roomId, eventId: planId } }),
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
  for (const message of incoming) {
    const previous = byId.get(message.id);
    // A delayed poll must not replace a newer locally acknowledged reaction.
    if (
      !previous ||
      BigInt(message.revision ?? '0') >= BigInt(previous.revision ?? '0')
    )
      byId.set(message.id, message);
  }
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
