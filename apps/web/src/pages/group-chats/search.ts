export function validateGroupChatSearch(search: Record<string, unknown>): {
  roomId?: string;
  agentId?: string;
} {
  const id = (value: unknown) =>
    typeof value === 'string' && /^[a-zA-Z0-9_-]{16}$/.test(value)
      ? value
      : undefined;
  return { roomId: id(search.roomId), agentId: id(search.agentId) };
}
