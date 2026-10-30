import { createContext, type ReactNode } from 'react';

export const FloatingChatContext = createContext(false);

export const ChatWorkspaceMenuContext = createContext<ReactNode>(null);

/** Opens the optional page-specific panel in the shared workspace. */
export const ChatWorkspacePanelContext = createContext<(() => void) | null>(
  null,
);
