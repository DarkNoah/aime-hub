import type { GroupChatReadState } from '@aime/shared/group-chats';

export type RoomUnreadScope = { roomId?: string; projectId?: string };

/** Server-backed receipts; an older poll must never undo a successful acknowledgement. */
export function createRoomUnreadResource(
  acknowledge: (
    roomId: string,
    sequence: string,
    signal: AbortSignal,
  ) => Promise<{ readSequence: string }>,
) {
  let rooms: GroupChatReadState[] = [];
  const confirmed = new Map<string, bigint>();
  const pending = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    receive(next: GroupChatReadState[]) {
      rooms = next;
      for (const room of rooms) {
        const sequence = BigInt(room.readSequence);
        if (sequence > (confirmed.get(room.roomId) ?? 0n))
          confirmed.set(room.roomId, sequence);
      }
      emit();
    },
    hasUnread({ roomId, projectId }: RoomUnreadScope = {}) {
      return rooms.some(
        (room) =>
          (roomId
            ? room.roomId === roomId
            : room.projectId === (projectId ?? null)) &&
          BigInt(room.latestSequence) > (confirmed.get(room.roomId) ?? 0n),
      );
    },
    async markRead(roomId: string, sequence: string) {
      if (
        pending.has(roomId) ||
        BigInt(sequence) <= (confirmed.get(roomId) ?? 0n)
      )
        return;
      const controller = new AbortController();
      pending.set(roomId, controller);
      try {
        const result = await acknowledge(roomId, sequence, controller.signal);
        if (controller.signal.aborted) return;
        const read = BigInt(result.readSequence);
        if (read > (confirmed.get(roomId) ?? 0n)) confirmed.set(roomId, read);
        emit();
      } catch {
        // Keep unread state on failure. The visible room retries while it is being read.
      } finally {
        if (pending.get(roomId) === controller) pending.delete(roomId);
      }
    },
    reset() {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
      confirmed.clear();
      rooms = [];
      emit();
    },
  };
}
