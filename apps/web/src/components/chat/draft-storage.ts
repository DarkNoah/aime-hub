export type ChatDraftScope = {
  userId?: string;
  threadId?: string;
  groupChatId?: string;
  projectId?: string;
};

export function chatDraftKey({
  userId,
  threadId,
  projectId,
  groupChatId,
}: ChatDraftScope) {
  if (!userId) return null;
  const scope = groupChatId
    ? ['group-chat', groupChatId]
    : threadId
      ? ['thread', threadId]
      : ['new', projectId ? ['project', projectId] : ['personal']];
  return `chat-draft:v1:${JSON.stringify([userId, ...scope])}`;
}

export function readChatDraft(key: string | null): string {
  if (!key) return '';
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function writeChatDraft(key: string | null, text: string) {
  if (!key) return;
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // The composer remains usable when browser storage is unavailable or full.
  }
}

export function clearChatDraft(key: string | null, submittedText: string) {
  // An in-flight send may finish after another composer has saved a newer draft.
  if (readChatDraft(key) === submittedText) writeChatDraft(key, '');
}
