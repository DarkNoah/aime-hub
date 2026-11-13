import { useCallback, useEffect, useRef, useState } from 'react';
import { fileErrorKey } from '@/components/file-manager/api';
import type { FileTreeState } from '@/components/file-manager/file-tree';
import type { SkillFileClient } from './file-client';

export function useSkillFiles(client: SkillFileClient): FileTreeState {
  const [directories, setDirectories] = useState<FileTreeState['directories']>(
    {},
  );
  const [expanded, setExpanded] = useState(new Set<string>());
  const [selected, setSelected] = useState('SKILL.md');
  const requests = useRef(new Map<string, AbortController>());
  const loadDirectory = useCallback(
    async (path: string) => {
      requests.current.get(path)?.abort();
      const controller = new AbortController();
      requests.current.set(path, controller);
      setDirectories((previous) => ({
        ...previous,
        [path]: { ...previous[path], loading: true, error: undefined },
      }));
      try {
        const listing = await client.list(path, controller.signal);
        if (!controller.signal.aborted)
          setDirectories((previous) => ({ ...previous, [path]: listing }));
      } catch (error) {
        if (!controller.signal.aborted)
          setDirectories((previous) => ({
            ...previous,
            [path]: {
              ...previous[path],
              loading: false,
              error: fileErrorKey(error),
            },
          }));
      } finally {
        if (requests.current.get(path) === controller)
          requests.current.delete(path);
      }
    },
    [client],
  );
  useEffect(() => {
    const pending = requests.current;
    void loadDirectory('');
    return () => {
      pending.forEach((request) => request.abort());
      pending.clear();
    };
  }, [loadDirectory]);
  function changeExpanded(next: Set<string>) {
    next.forEach((path) => {
      if (!expanded.has(path)) void loadDirectory(path);
    });
    setExpanded(next);
  }
  return {
    client,
    directories,
    expanded,
    selected,
    loadDirectory,
    changeExpanded,
    scope: 'thread',
    openFile: setSelected,
    toggle(path) {
      const next = new Set(expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      changeExpanded(next);
    },
  };
}
