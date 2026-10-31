import { randomUUID } from '@aime/shared/uuid';
import type { HistoryState } from '@tanstack/react-router';

declare module '@tanstack/react-router' {
  interface HistoryState {
    chatWorkspace?: {
      threadId: string;
      view: 'browser' | 'issues';
      requestId: string;
    };
  }
}

export function browserWorkspaceState(threadId: string): HistoryState {
  return {
    chatWorkspace: {
      threadId,
      view: 'browser',
      requestId: randomUUID(),
    },
  };
}

export function issueWorkspaceState(threadId: string): HistoryState {
  return {
    chatWorkspace: { threadId, view: 'issues', requestId: randomUUID() },
  };
}
