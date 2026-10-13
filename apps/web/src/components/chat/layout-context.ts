import { createContext, type ReactNode } from 'react';

export const FloatingChatContext = createContext(false);

export const ChatWorkspaceMenuContext = createContext<ReactNode>(null);
