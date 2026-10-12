import { createContext, useContext } from 'react';

export const WorkspaceFileContext = createContext<
  ((path: string, kind?: 'file' | 'directory') => void) | null
>(null);

export function useWorkspaceFile() {
  return useContext(WorkspaceFileContext);
}
