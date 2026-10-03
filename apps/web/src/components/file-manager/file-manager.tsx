import { useEffect, useRef, useState } from 'react';
import {
  File,
  FilePlus2,
  Files,
  FolderPlus,
  PanelRightClose,
  RotateCw,
  Search,
  X,
} from 'lucide-react';
import type { FileSearch } from '@aime/shared/files';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { filesApi, fileErrorKey } from './api';
import { EntryActions, type EntryAction } from './entry-actions';
import { rootEntry } from './state';
import { EntryDialog } from './entry-dialog';
import { FileTree } from './file-tree';
import { FilePreview } from './file-preview';
import type { FileManagerState } from './use-file-manager';

export default function FileManager({
  state,
  onClose,
}: {
  state: FileManagerState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<EntryAction | null>(null);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLElement>(null);
  const [stacked, setStacked] = useState(false);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState<{
    query: string;
    data?: FileSearch;
    error?: ReturnType<typeof fileErrorKey>;
  } | null>(null);
  const trimmed = query.trim();
  const { threadId, revision } = state;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      setStacked(entry.contentRect.width < 480);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!trimmed || !threadId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void filesApi
        .search(threadId, trimmed, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setSearch({ query: trimmed, data });
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setSearch({ query: trimmed, error: fileErrorKey(cause) });
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [threadId, trimmed, revision]);
  const result = search?.query === trimmed ? search : null;
  const groups = new Map<string, FileSearch['matches']>();
  for (const match of result?.data?.matches ?? []) {
    const group = groups.get(match.path) ?? [];
    group.push(match);
    groups.set(match.path, group);
  }
  const activeTab = state.tabs.find((tab) => tab.path === state.selected);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [state.selected]);
  return (
    <section
      ref={containerRef}
      className="flex h-full min-h-0 min-w-0 flex-col bg-card"
      aria-label={t('files.title')}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Files className="size-4 shrink-0 text-primary" />
        <h2 className="min-w-0 flex-1 text-sm font-semibold">
          {t('files.title')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!threadId}
          aria-label={t('files.createFile')}
          title={t('files.createFile')}
          onClick={() =>
            setAction({ operation: 'createFile', entry: rootEntry })
          }
        >
          <FilePlus2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!threadId}
          aria-label={t('files.createFolder')}
          title={t('files.createFolder')}
          onClick={() =>
            setAction({ operation: 'createFolder', entry: rootEntry })
          }
        >
          <FolderPlus className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!threadId}
          aria-label={t('files.refresh')}
          title={t('files.refresh')}
          onClick={state.refresh}
        >
          <RotateCw className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <PanelRightClose className="size-4" />
        </Button>
      </header>
      {!threadId ? (
        <div className="m-auto max-w-xs px-5 py-12 text-center text-sm text-muted-foreground">
          <Files className="mx-auto mb-3 size-8" />
          {t('files.startChat')}
        </div>
      ) : (
        <ResizablePanelGroup
          orientation={stacked ? 'vertical' : 'horizontal'}
          className="flex-1"
        >
          <ResizablePanel
            defaultSize="38%"
            minSize={stacked ? 100 : 160}
            maxSize="70%"
            className="flex min-h-0 min-w-0 flex-col"
          >
            <div className="shrink-0 space-y-2 border-b p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
                <Input
                  className="h-9 pr-8 pl-8 text-xs"
                  value={query}
                  maxLength={200}
                  placeholder={t('files.searchPlaceholder')}
                  aria-label={t('files.search')}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1 right-1 size-7"
                    aria-label={t('files.clearSearch')}
                    onClick={() => setQuery('')}
                  >
                    <X className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
            <ScrollArea
              className="min-h-0 flex-1"
              viewportProps={{ className: '[&>div]:!block' }}
            >
              {trimmed ? (
                <div className="p-2" aria-live="polite">
                  {!result && (
                    <p
                      role="status"
                      className="p-2 text-xs text-muted-foreground"
                    >
                      {t('files.searching')}
                    </p>
                  )}
                  {result?.error && (
                    <div role="alert" className="p-2 text-xs text-destructive">
                      {t(result.error)}
                      <Button variant="ghost" size="sm" onClick={state.refresh}>
                        {t('files.retry')}
                      </Button>
                    </div>
                  )}
                  {result?.data && (
                    <>
                      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                        <span>{t('files.results')}</span>
                        <Badge variant="secondary">
                          {result.data.matches.length}
                        </Badge>
                      </div>
                      {!result.data.matches.length && (
                        <p className="p-2 text-xs text-muted-foreground">
                          {t('files.noResults')}
                        </p>
                      )}
                      {[...groups].map(([path, matches]) => (
                        <div key={path} className="mb-1">
                          <EntryActions entry={matches[0]} onAction={setAction}>
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              title={path}
                              onClick={() => state.openFile(path)}
                            >
                              <File className="size-3.5 shrink-0" />
                              <span className="truncate font-medium">
                                {matches[0].name}
                              </span>
                              <span className="ml-1 truncate text-[11px] text-muted-foreground">
                                {path.includes('/')
                                  ? path.slice(0, path.lastIndexOf('/'))
                                  : ''}
                              </span>
                              {matches[0].line && (
                                <Badge
                                  variant="secondary"
                                  className="ml-auto shrink-0 text-[10px]"
                                >
                                  {matches.length}
                                </Badge>
                              )}
                            </button>
                          </EntryActions>
                          {matches
                            .filter((match) => match.line !== undefined)
                            .map((match) => (
                              <button
                                key={match.line}
                                type="button"
                                title={`${path}:${match.line}`}
                                className="flex w-full min-w-0 items-baseline gap-2 rounded py-1 pr-2 pl-7 text-left font-mono text-xs hover:bg-muted/80 focus-visible:outline-ring"
                                onClick={() => state.openFile(path, match.line)}
                              >
                                <span className="shrink-0 text-muted-foreground">
                                  {match.line}
                                </span>
                                <span className="truncate">{match.text}</span>
                              </button>
                            ))}
                        </div>
                      ))}
                      {result.data.truncated && (
                        <p className="p-2 text-xs text-muted-foreground">
                          {t('files.searchLimit')}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <FileTree state={state} onAction={setAction} />
              )}
            </ScrollArea>
          </ResizablePanel>
          <ResizableHandle
            aria-label={t(
              stacked ? 'files.resizeTreeHeight' : 'files.resizeTreeWidth',
            )}
            title={t(
              stacked ? 'files.resizeTreeHeight' : 'files.resizeTreeWidth',
            )}
          />
          <ResizablePanel
            minSize={stacked ? 120 : 240}
            className="min-h-0 min-w-0"
          >
            {activeTab ? (
              <Tabs
                value={state.selected}
                onValueChange={state.setSelected}
                className="h-full min-h-0 gap-0"
              >
                <ScrollArea className="w-full shrink-0 border-b bg-muted/30">
                  <TabsList
                    variant="line"
                    aria-label={t('files.openFiles')}
                    className="h-10 justify-start gap-0 p-0"
                  >
                    {state.tabs.map((tab) => (
                      <div
                        key={tab.path}
                        className="flex h-full max-w-56 items-center border-r"
                      >
                        <TabsTrigger
                          ref={
                            tab.path === state.selected
                              ? activeTabRef
                              : undefined
                          }
                          value={tab.path}
                          title={tab.path}
                          className="h-full min-w-0 rounded-none px-3 text-xs after:bottom-0"
                        >
                          <File className="size-3.5" />
                          <span className="truncate">
                            {tab.path.split('/').at(-1)}
                          </span>
                        </TabsTrigger>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="mr-1 size-6 shrink-0"
                          aria-label={t('files.closeFile', { name: tab.path })}
                          onClick={() => state.closeTab(tab.path)}
                        >
                          <X className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </TabsList>
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
                <TabsContent value={state.selected} className="min-h-0">
                  <FilePreview
                    key={activeTab.path}
                    threadId={threadId}
                    path={activeTab.path}
                    line={activeTab.line}
                    revision={revision}
                  />
                </TabsContent>
              </Tabs>
            ) : (
              <div className="flex h-full items-center justify-center p-6">
                <div className="max-w-xs text-center">
                  <Files className="mx-auto mb-3 size-8 text-muted-foreground" />
                  <p className="text-sm font-medium">{t('files.selectFile')}</p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {t('files.previewHint')}
                  </p>
                </div>
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
      {action && (
        <EntryDialog
          action={action}
          state={state}
          onClose={() => setAction(null)}
        />
      )}
    </section>
  );
}
