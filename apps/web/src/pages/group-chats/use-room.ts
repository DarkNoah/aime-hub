import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GroupChatAgent,
  GroupChatA2AMember,
  GroupChatDetail,
  GroupChatMessage,
  GroupChatFile,
  MemberProfile,
} from '@aime/shared/group-chats';
import { apiErrorCode } from '@/lib/rpc';
import {
  type GroupChatErrorKey,
  groupChatApi,
  groupChatErrorKey,
  lookupMembers,
  mergeMessages,
} from './api';

export function useRoom(roomId: string, projectId?: string) {
  const [room, setRoom] = useState<GroupChatDetail | null>(null);
  const [messages, setMessages] = useState<GroupChatMessage[]>([]);
  const [profiles, setProfiles] = useState<Map<string, MemberProfile>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<
    typeof groupChatErrorKey
  > | null>(null);
  const [syncError, setSyncError] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [revision, setRevision] = useState(0);
  const lifecycle = useRef<AbortController | null>(null);
  const earlierBusy = useRef(false);
  // Only history fetches advance this cursor. Message edits have a separate cursor.
  const historyBefore = useRef<string | null>(null);
  const earlierChanges = useRef(new Map<string, GroupChatMessage>());
  const removedA2aIds = useRef(new Set<string>());

  useEffect(() => {
    const controller = new AbortController();
    removedA2aIds.current.clear();
    lifecycle.current = controller;
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    let cursor = '0';
    let changeCursor: string | undefined;
    let currentRoom: GroupChatDetail;
    let members = new Map<string, MemberProfile>();
    let polls = 0;
    const visibleRoom = (detail: GroupChatDetail): GroupChatDetail => ({
      ...detail,
      a2aMembers: detail.a2aMembers?.filter(
        (member) => !removedA2aIds.current.has(member.id),
      ),
    });

    async function hydrate(ids: string[], refresh = false) {
      const missing = ids.filter((id) => refresh || !members.has(id));
      if (!missing.length) return;
      const values = await lookupMembers(missing, roomId, signal);
      if (signal.aborted) return;
      members = new Map(members);
      for (const profile of values) members.set(profile.id, profile);
      setProfiles((previous) => new Map([...previous, ...members]));
    }
    async function poll() {
      if (signal.aborted) return;
      try {
        if (document.visibilityState !== 'hidden') {
          // Keep agent status current; refresh profile details less frequently.
          currentRoom = await groupChatApi.get(roomId, signal);
          await hydrate(currentRoom.memberIds, ++polls % 5 === 0);
          if (!signal.aborted) setRoom(visibleRoom(currentRoom));
          let more = true;
          while (more && !signal.aborted) {
            const page = await groupChatApi.messages(
              roomId,
              changeCursor === undefined
                ? { after: cursor }
                : { afterRevision: changeCursor },
              signal,
            );
            if (earlierBusy.current) {
              for (const message of page.messages)
                earlierChanges.current.set(message.id, message);
            }
            // Changes to unloaded history must not introduce a gap in the
            // current window or move its pagination boundary.
            const incoming = page.messages.filter(
              (message) =>
                historyBefore.current === null ||
                BigInt(message.sequence) >= BigInt(historyBefore.current),
            );
            await hydrate(
              incoming
                .filter((message) => message.senderKind === 'user')
                .map((message) => message.senderId),
            );
            if (signal.aborted) return;
            if (incoming.length)
              setMessages((previous) => mergeMessages(previous, incoming));
            if (page.messages.length) cursor = page.messages.at(-1)!.sequence;
            if (page.revision !== undefined) changeCursor = page.revision;
            more = page.hasMore;
          }
          if (!signal.aborted) setSyncError(false);
        }
      } catch (cause) {
        if (signal.aborted) return;
        if (
          ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(
            apiErrorCode(cause) ?? '',
          )
        ) {
          setRoom(null);
          setMessages([]);
          setProfiles(new Map());
          setError(groupChatErrorKey(cause));
          return;
        }
        setSyncError(true);
      }
      if (!signal.aborted) timer = setTimeout(() => void poll(), 2500);
    }
    async function initialize() {
      try {
        const [detail, page] = await Promise.all([
          groupChatApi.get(roomId, signal),
          groupChatApi.messages(roomId, {}, signal),
        ]);
        if (detail.projectId !== (projectId ?? null)) {
          if (!signal.aborted) setError('groupChat.unavailable');
          return;
        }
        currentRoom = detail;
        await hydrate([
          ...detail.memberIds,
          ...page.messages
            .filter((message) => message.senderKind === 'user')
            .map((message) => message.senderId),
        ]);
        if (signal.aborted) return;
        cursor = page.messages.at(-1)?.sequence ?? '0';
        historyBefore.current = page.messages[0]?.sequence ?? null;
        changeCursor = page.revision;
        setRoom(visibleRoom(detail));
        setMessages(page.messages);
        setHasEarlier(page.hasMore);
        setError(null);
        setSyncError(false);
        timer = setTimeout(() => void poll(), 2500);
      } catch (cause) {
        if (!signal.aborted) setError(groupChatErrorKey(cause));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }
    void initialize();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [roomId, projectId, revision]);

  const loadEarlier = useCallback(async () => {
    const signal = lifecycle.current?.signal;
    const before = historyBefore.current;
    if (
      earlierBusy.current ||
      !hasEarlier ||
      !before ||
      !signal ||
      signal.aborted
    )
      return;
    earlierBusy.current = true;
    earlierChanges.current.clear();
    setLoadingEarlier(true);
    try {
      const page = await groupChatApi.messages(roomId, { before }, signal);
      const authors = await lookupMembers(
        page.messages
          .filter((message) => message.senderKind === 'user')
          .map((message) => message.senderId),
        roomId,
        signal,
      );
      if (signal.aborted) return;
      setProfiles(
        (previous) =>
          new Map([
            ...previous,
            ...authors.map((profile) => [profile.id, profile] as const),
          ]),
      );
      if (page.messages.length)
        historyBefore.current = page.messages[0].sequence;
      // A poll may have observed a newer reaction while this page was in flight.
      const pageIds = new Set(page.messages.map((message) => message.id));
      const updates = [...earlierChanges.current.values()].filter((message) =>
        pageIds.has(message.id),
      );
      setMessages((previous) =>
        mergeMessages(mergeMessages(previous, page.messages), updates),
      );
      setHasEarlier(page.hasMore);
    } finally {
      earlierChanges.current.clear();
      earlierBusy.current = false;
      if (!signal.aborted) setLoadingEarlier(false);
    }
  }, [hasEarlier, roomId]);

  async function send(
    id: string,
    text: string,
    replyToId?: string,
    files?: GroupChatFile[],
  ) {
    const signal = lifecycle.current?.signal;
    const message = await groupChatApi.send(roomId, id, text, replyToId, files);
    if (!signal?.aborted)
      setMessages((previous) => mergeMessages(previous, [message]));
    // Polling has its own cursor. Advancing it here could skip another member's send.
  }

  const merge = (message: GroupChatMessage) => {
    if (!lifecycle.current?.signal.aborted)
      setMessages((previous) => mergeMessages(previous, [message]));
  };
  const updateAgent = (agent: GroupChatAgent) =>
    setRoom(
      (previous) =>
        previous && {
          ...previous,
          agents: previous.agents.some((item) => item.id === agent.id)
            ? previous.agents.map((item) =>
                item.id === agent.id ? agent : item,
              )
            : [...previous.agents, agent],
        },
    );
  return {
    room,
    messages,
    profiles,
    loading,
    error: error as GroupChatErrorKey | null,
    syncError,
    hasEarlier,
    loadingEarlier,
    loadEarlier,
    send,
    react: async (messageId: string, emoji: string, active: boolean) => {
      merge(await groupChatApi.react(roomId, messageId, emoji, active));
    },
    respondUi: async (
      messageId: string,
      id: string,
      data: NonNullable<GroupChatMessage['uiResponse']>['data'],
    ) => {
      merge(await groupChatApi.respondUi(roomId, messageId, id, data));
    },
    updateAgent,
    updateA2aMember: (member: GroupChatA2AMember) => {
      if (
        lifecycle.current?.signal.aborted ||
        removedA2aIds.current.has(member.id)
      )
        return;
      setRoom((previous) => {
        if (!previous) return previous;
        const members = previous.a2aMembers ?? [];
        return {
          ...previous,
          a2aMembers: members.some((item) => item.id === member.id)
            ? members.map((item) => (item.id === member.id ? member : item))
            : [...members, member],
        };
      });
    },
    removeA2aMember: (memberId: string) => {
      if (lifecycle.current?.signal.aborted) return;
      removedA2aIds.current.add(memberId);
      const name = room?.a2aMembers?.find(
        (member) => member.id === memberId,
      )?.name;
      if (name)
        setMessages((previous) =>
          previous.map((message) =>
            message.senderKind === 'a2a' && message.senderId === memberId
              ? { ...message, senderName: name }
              : message,
          ),
        );
      setRoom(
        (previous) =>
          previous && {
            ...previous,
            a2aMembers: previous.a2aMembers?.filter(
              (member) => member.id !== memberId,
            ),
          },
      );
    },
    addMember: (member: MemberProfile) => {
      if (lifecycle.current?.signal.aborted) return;
      setProfiles((previous) => new Map(previous).set(member.id, member));
      setRoom(
        (previous) =>
          previous && {
            ...previous,
            memberIds: previous.memberIds.includes(member.id)
              ? previous.memberIds
              : [...previous.memberIds, member.id],
          },
      );
    },
    removeAgent: (agentId: string) =>
      setRoom(
        (previous) =>
          previous && {
            ...previous,
            agents: previous.agents.filter((agent) => agent.id !== agentId),
          },
      ),
    retry: () => {
      setLoading(true);
      setError(null);
      setRevision((value) => value + 1);
    },
  };
}
