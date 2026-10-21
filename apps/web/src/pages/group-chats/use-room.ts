import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GroupChatDetail,
  GroupChatMessage,
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

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    let cursor = '0';
    let currentRoom: GroupChatDetail;
    let members = new Map<string, MemberProfile>();
    let polls = 0;
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
          // Re-read membership periodically, including when nobody is speaking.
          if (++polls % 5 === 0) {
            currentRoom = await groupChatApi.get(roomId, signal);
            await hydrate(currentRoom.memberIds, true);
            if (!signal.aborted) setRoom(currentRoom);
          }
          let more = true;
          while (more && !signal.aborted) {
            const page = await groupChatApi.messages(
              roomId,
              { after: cursor },
              signal,
            );
            await hydrate(page.messages.map((message) => message.senderId));
            if (signal.aborted) return;
            if (page.messages.length) {
              setMessages((previous) => mergeMessages(previous, page.messages));
              cursor = page.messages.at(-1)!.sequence;
            }
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
          ...page.messages.map((message) => message.senderId),
        ]);
        if (signal.aborted) return;
        cursor = page.messages.at(-1)?.sequence ?? '0';
        setRoom(detail);
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
    if (
      earlierBusy.current ||
      !hasEarlier ||
      !messages[0] ||
      !signal ||
      signal.aborted
    )
      return;
    earlierBusy.current = true;
    setLoadingEarlier(true);
    try {
      const page = await groupChatApi.messages(
        roomId,
        { before: messages[0].sequence },
        signal,
      );
      const authors = await lookupMembers(
        page.messages.map((message) => message.senderId),
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
      setMessages((previous) => mergeMessages(previous, page.messages));
      setHasEarlier(page.hasMore);
    } finally {
      earlierBusy.current = false;
      if (!signal.aborted) setLoadingEarlier(false);
    }
  }, [hasEarlier, messages, roomId]);

  async function send(id: string, text: string) {
    const signal = lifecycle.current?.signal;
    const message = await groupChatApi.send(roomId, id, text);
    if (!signal?.aborted)
      setMessages((previous) => mergeMessages(previous, [message]));
    // Polling has its own cursor. Advancing it here could skip another member's send.
  }

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
    retry: () => {
      setLoading(true);
      setError(null);
      setRevision((value) => value + 1);
    },
  };
}
