import { createContext, useCallback, useContext } from 'react';
import { workspaceReferencePath, type FileScope } from '@aime/shared/files';

export const WorkspaceFileThreadContext = createContext<string | undefined>(
  undefined,
);

export const WorkspaceFileContext = createContext<
  ((path: string, kind?: 'file' | 'directory', line?: number) => void) | null
>(null);

export function useWorkspaceFile() {
  return useContext(WorkspaceFileContext);
}

/** Preview paths are relative to the active file manager's root. */
export function useScopedWorkspaceFile(scope: FileScope) {
  const openFile = useWorkspaceFile();
  const open = useCallback(
    (path: string, kind: 'file' | 'directory', line?: number) => {
      const reference =
        scope === 'shared'
          ? workspaceReferencePath({ path, scope, kind })
          : path || '.';
      openFile?.(reference, kind, line);
    },
    [openFile, scope],
  );
  return openFile ? open : undefined;
}
