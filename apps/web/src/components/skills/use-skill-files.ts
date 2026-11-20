import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fileErrorKey } from '@/components/file-manager/api';
import type { FileTreeState } from '@/components/file-manager/file-tree';
import { parentPath, type FileTab } from '@/components/file-manager/state';
import type { SkillFileClient } from './file-client';

export function useSkillFiles(client: SkillFileClient) {
  const { t } = useTranslation();
  const [directories, setDirectories] = useState<FileTreeState['directories']>(
    {},
  );
  const [expanded, setExpanded] = useState(new Set<string>());
  const [file, setFile] = useState<FileTab>({ path: 'SKILL.md' });
  const [selectedDirectory, setSelectedDirectory] = useState<string>();
  const navigation = useRef<AbortController | null>(null);
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
      navigation.current?.abort();
      pending.forEach((request) => request.abort());
      pending.clear();
    };
  }, [loadDirectory]);
  function changeExpanded(next: Set<string>) {
    navigation.current?.abort();
    next.forEach((path) => {
      if (!expanded.has(path)) void loadDirectory(path);
    });
    setExpanded(next);
  }
  function openFile(path: string, line?: number) {
    navigation.current?.abort();
    setSelectedDirectory(undefined);
    setFile((previous) => ({
      path,
      line,
      navigation: (previous.navigation ?? 0) + 1,
    }));
  }
  async function openLink(
    path: string,
    _kind: 'file' | 'directory',
    line?: number,
  ) {
    navigation.current?.abort();
    const controller = new AbortController();
    navigation.current = controller;
    try {
      const kind = await client.resolveKind(path, controller.signal);
      if (controller.signal.aborted) return;
      if (!kind) {
        toast.error(t('files.notFound'));
        return;
      }
      const next = new Set(expanded);
      let directory = kind === 'directory' ? path : parentPath(path);
      while (directory) {
        next.add(directory);
        directory = parentPath(directory);
      }
      changeExpanded(next);
      if (kind === 'directory') setSelectedDirectory(path);
      else openFile(path, line);
    } catch (error) {
      if (!controller.signal.aborted) toast.error(t(fileErrorKey(error)));
    }
  }
  return {
    client,
    directories,
    expanded,
    selected: selectedDirectory ?? file.path,
    file,
    openLink,
    loadDirectory,
    changeExpanded,
    scope: 'thread' as const,
    openFile,
    toggle(path: string) {
      const next = new Set(expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      changeExpanded(next);
    },
  };
}
