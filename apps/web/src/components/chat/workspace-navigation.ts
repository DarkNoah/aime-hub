import type { HistoryState } from '@tanstack/react-router';

declare module '@tanstack/react-router' {
  interface HistoryState {
    chatWorkspace?: { threadId: string; view: 'browser'; requestId: string };
  }
}

export function browserWorkspaceState(threadId: string): HistoryState {
  return {
    chatWorkspace: {
      threadId,
      view: 'browser',
      requestId: crypto.randomUUID(),
    },
  };
}
