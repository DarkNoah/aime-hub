import { createContext, useContext } from 'react';

export const WorkspaceFileThreadContext = createContext<string | undefined>(
  undefined,
);

export const WorkspaceFileContext = createContext<
  ((path: string, kind?: 'file' | 'directory', line?: number) => void) | null
>(null);

export function useWorkspaceFile() {
  return useContext(WorkspaceFileContext);
}
