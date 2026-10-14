import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { FileListing, FileMutation, FileScope } from '@aime/shared/files';
import { fileErrorKey } from './api';
import { createWorkspaceFileClient } from './workspace-client';
import { parentPath, renameTabs, withinPath, type FileTab } from './state';
import { useFileUploads } from './use-file-uploads';

type Directory = Partial<FileListing> & {
  loading?: boolean;
  error?: ReturnType<typeof fileErrorKey>;
};

export function useFileManager(
  threadId: string | undefined,
  visible: boolean,
  scope: FileScope = 'thread',
) {
  const [client] = useState(() => createWorkspaceFileClient(undefined, scope));
  const [available, setAvailable] = useState(!!threadId);
  if (threadId && !available) setAvailable(true);
  useLayoutEffect(() => {
    client.setThread(threadId);
  }, [client, threadId]);
  const [directories, setDirectories] = useState<Record<string, Directory>>({});
  const [expanded, setExpanded] = useState(new Set<string>());
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [selected, setSelected] = useState('');
  const [currentDirectory, setCurrentDirectory] = useState('');
  const [revision, setRevision] = useState(0);
  const requests = useRef(new Map<string, AbortController>());
  const loadDirectory = useCallback(
    async (path: string) => {
      if (!available) return;
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
    [client, available],
  );
  useEffect(() => {
    const pending = requests.current;
    return () => {
      pending.forEach((controller) => controller.abort());
      pending.clear();
    };
  }, []);
  useEffect(() => {
    if (visible) void loadDirectory('');
  }, [visible, loadDirectory]);

  const openFile = useCallback((path: string, line?: number) => {
    setCurrentDirectory(parentPath(path));
    setTabs((previous) =>
      previous.some((tab) => tab.path === path)
        ? previous.map((tab) => (tab.path === path ? { path, line } : tab))
        : [...previous, { path, line }],
    );
    setSelected(path);
  }, []);
  const uploaded = useCallback(
    async (directory: string) => {
      if (directory)
        setExpanded((previous) => new Set([...previous, directory]));
      await loadDirectory(directory);
      setRevision((value) => value + 1);
    },
    [loadDirectory],
  );
  const uploads = useFileUploads(client, uploaded);
  const revealFile = useCallback(
    (path: string) => {
      // Tool paths may be relative to '.', while the file API uses root-relative paths.
      const relativePath = path.replace(/^(\.\/)+/, '');
      openFile(relativePath);
      const parents: string[] = [];
      let parent = parentPath(relativePath);
      while (parent) {
        parents.push(parent);
        parent = parentPath(parent);
      }
      setExpanded((previous) => new Set([...previous, ...parents]));
      // Refresh ancestors as a tool may just have created the plan file.
      ['', ...parents].forEach((directory) => void loadDirectory(directory));
      setRevision((value) => value + 1);
    },
    [loadDirectory, openFile],
  );
  const revealDirectory = useCallback(
    (path: string) => {
      const relativePath = path.replace(/^(\.\/)+/, '');
      const directories: string[] = [];
      let directory = relativePath;
      while (directory) {
        directories.push(directory);
        directory = parentPath(directory);
      }
      setSelected(relativePath);
      setCurrentDirectory(relativePath);
      setExpanded((previous) => new Set([...previous, ...directories]));
      ['', ...directories].forEach((entry) => void loadDirectory(entry));
      setRevision((value) => value + 1);
    },
    [loadDirectory],
  );
  function closeTab(path: string) {
    const index = tabs.findIndex((tab) => tab.path === path);
    const next = tabs.filter((tab) => tab.path !== path);
    setTabs(next);
    if (selected === path)
      setSelected(next[Math.min(index, next.length - 1)]?.path ?? '');
  }
  function changeExpanded(next: Set<string>) {
    next.forEach((path) => {
      if (!expanded.has(path)) {
        setCurrentDirectory(path);
        void loadDirectory(path);
      }
    });
    setExpanded(next);
  }
  function toggle(path: string) {
    setCurrentDirectory(path);
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    changeExpanded(next);
  }
  function refresh() {
    void loadDirectory('');
    expanded.forEach((path) => void loadDirectory(path));
    setRevision((value) => value + 1);
  }
  async function mutate(input: FileMutation) {
    if (!available) return;
    const result = await client.mutate(input);
    setCurrentDirectory((previous) => {
      if (!withinPath(previous, input.path)) return previous;
      if (input.operation === 'rename')
        return result.path + previous.slice(input.path.length);
      if (input.operation === 'delete') return parentPath(input.path);
      return previous;
    });
    // Invalidate old directory requests before adjusting descendant paths.
    requests.current.forEach((controller) => controller.abort());
    requests.current.clear();
    setDirectories((previous) =>
      Object.fromEntries(
        Object.entries(previous)
          .filter(
            ([path]) =>
              input.operation !== 'delete' || !withinPath(path, input.path),
          )
          .map(([path, directory]) => {
            const renamed = (value: string) =>
              input.operation === 'rename' && withinPath(value, input.path)
                ? result.path + value.slice(input.path.length)
                : value;
            return [
              renamed(path),
              {
                ...directory,
                loading: false,
                entries: directory.entries?.map((entry) => ({
                  ...entry,
                  path: renamed(entry.path),
                  name: renamed(entry.path).split('/').at(-1)!,
                })),
              },
            ];
          }),
      ),
    );
    if (input.operation === 'rename') {
      setTabs((previous) => renameTabs(previous, input.path, result.path));
      setSelected((previous) =>
        withinPath(previous, input.path)
          ? result.path + previous.slice(input.path.length)
          : previous,
      );
    } else if (input.operation === 'delete') {
      const next = tabs.filter((tab) => !withinPath(tab.path, input.path));
      setTabs(next);
      if (withinPath(selected, input.path))
        setSelected(next.at(-1)?.path ?? '');
    } else if (input.kind === 'file') openFile(result.path);
    const nextExpanded = new Set(
      [...expanded]
        .filter(
          (path) =>
            input.operation !== 'delete' || !withinPath(path, input.path),
        )
        .map((path) =>
          input.operation === 'rename' && withinPath(path, input.path)
            ? result.path + path.slice(input.path.length)
            : path,
        ),
    );
    const parent = parentPath(input.path);
    if (parent) nextExpanded.add(parent);
    setExpanded(nextExpanded);
    await loadDirectory(parent);
    setRevision((value) => value + 1);
  }
  return {
    client,
    scope,
    uploads,
    available,
    directories,
    expanded,
    tabs,
    selected,
    currentDirectory,
    setCurrentDirectory,
    revision,
    loadDirectory,
    openFile,
    revealFile,
    revealDirectory,
    closeTab,
    setSelected,
    changeExpanded,
    toggle,
    refresh,
    mutate,
  };
}
export type FileManagerState = ReturnType<typeof useFileManager>;
