import { createContext, useContext } from 'react';

export const WorkspaceFileContext = createContext<
  ((path: string) => void) | null
>(null);

export function useWorkspaceFile() {
  return useContext(WorkspaceFileContext);
}
