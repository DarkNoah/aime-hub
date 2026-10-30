export function validateGroupChatSearch(search: Record<string, unknown>): {
  roomId?: string;
} {
  return typeof search.roomId === 'string' &&
    /^[a-zA-Z0-9_-]{16}$/.test(search.roomId)
    ? { roomId: search.roomId }
    : {};
}
