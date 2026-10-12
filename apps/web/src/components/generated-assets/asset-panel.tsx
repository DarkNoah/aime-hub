import { useEffect, useRef, useState } from 'react';
import Masonry from 'react-responsive-masonry';
import { Images, PanelRightClose, Paperclip, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  type AssetList,
  type AssetQuery,
  type GeneratedAsset,
} from '@aime/shared/assets';
import { MAX_CHAT_FILES } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { fileErrorKey } from '@/components/file-manager/api';
import { assetsApi } from './api';
import { AssetCard } from './asset-card';
import { AssetFilters } from './asset-filters';
import { useAssetAttachments } from './context';

export default function AssetPanel({
  threadId,
  revision,
  onClose,
}: {
  threadId?: string;
  revision: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const attachments = useAssetAttachments();
  const [kind, setKind] = useState<AssetQuery['kind']>('all');
  const [sort, setSort] = useState<AssetQuery['sort']>('newest');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<GeneratedAsset[]>([]);
  const container = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setColumns(Math.max(1, Math.floor((entry.contentRect.width - 16) / 210))),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const queryKey = JSON.stringify([threadId, kind, sort, query]);
  return (
    <section
      ref={container}
      className="flex h-full min-h-0 flex-col bg-card"
      aria-label={t('assets.title')}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Images className="size-4 text-primary" aria-hidden="true" />
        <h2 className="flex-1 text-sm font-semibold">{t('assets.title')}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!threadId}
          aria-label={t('assets.refresh')}
          title={t('assets.refresh')}
          onClick={() => setRefresh((value) => value + 1)}
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
        <div className="m-auto px-6 text-center text-sm text-muted-foreground">
          {t('assets.startChat')}
        </div>
      ) : (
        <>
          <AssetFilters
            search={search}
            kind={kind}
            sort={sort}
            onSearch={setSearch}
            onKind={setKind}
            onSort={setSort}
            onReset={() => {
              setSearch('');
              setQuery('');
              setKind('all');
              setSort('newest');
            }}
          />
          <AssetResults
            key={queryKey}
            threadId={threadId}
            query={{ kind, sort, search: query }}
            refresh={`${refresh}:${revision}`}
            columns={columns}
            selected={selected}
            onSelect={(asset, checked) => {
              if (!checked) {
                setSelected((previous) =>
                  previous.filter((item) => item.id !== asset.id),
                );
                return;
              }
              if (selected.some((item) => item.id === asset.id)) return;
              if (selected.length >= MAX_CHAT_FILES) {
                toast.error(t('assets.limit', { count: MAX_CHAT_FILES }));
                return;
              }
              setSelected((previous) => [...previous, asset]);
            }}
          />
          {selected.length > 0 && (
            <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-card p-3">
              <Badge variant="secondary">
                {t('assets.selected', { count: selected.length })}
              </Badge>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                {t('assets.clear')}
              </Button>
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => {
                  if (attachments?.add(selected)) {
                    setSelected([]);
                    toast.success(t('assets.added'));
                  }
                }}
              >
                <Paperclip className="size-4" />
                {t('assets.addToChat')}
              </Button>
            </footer>
          )}
        </>
      )}
    </section>
  );
}

function AssetResults({
  threadId,
  query,
  refresh,
  columns,
  selected,
  onSelect,
}: {
  threadId: string;
  query: Partial<AssetQuery>;
  refresh: string;
  columns: number;
  selected: GeneratedAsset[];
  onSelect: (asset: GeneratedAsset, selected: boolean) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<AssetList>();
  const [error, setError] = useState<ReturnType<typeof fileErrorKey>>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const paging = useRef<AbortController | null>(null);
  const loadedPages = useRef(1);
  const queryRef = useRef(query);
  useEffect(() => {
    const controller = new AbortController();
    paging.current?.abort();
    // Re-read the pages already shown so live updates preserve ordering and scroll.
    const load = async () => {
      let result: AssetList = { items: [], nextCursor: null };
      for (let page = 0; page < loadedPages.current; page++) {
        const next = await assetsApi.list(
          threadId,
          { ...queryRef.current, cursor: result.nextCursor ?? undefined },
          controller.signal,
        );
        result = {
          items: [...result.items, ...next.items],
          nextCursor: next.nextCursor,
        };
        if (!next.nextCursor) break;
      }
      if (!controller.signal.aborted) {
        setData(result);
        setError(undefined);
      }
    };
    void load().catch((cause) => {
      if (!controller.signal.aborted) setError(fileErrorKey(cause));
    });
    return () => {
      controller.abort();
      paging.current?.abort();
    };
  }, [threadId, refresh, retry]);
  async function more() {
    if (!data?.nextCursor || loadingMore) return;
    const controller = new AbortController();
    paging.current = controller;
    setLoadingMore(true);
    try {
      const next = await assetsApi.list(
        threadId,
        { ...queryRef.current, cursor: data.nextCursor },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        loadedPages.current++;
        setData((previous) => ({
          items: [
            ...previous!.items,
            ...next.items.filter(
              (item) =>
                !previous!.items.some((existing) => existing.id === item.id),
            ),
          ],
          nextCursor: next.nextCursor,
        }));
        setError(undefined);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(fileErrorKey(cause));
    } finally {
      if (paging.current === controller) setLoadingMore(false);
    }
  }
  return (
    <ScrollArea
      className="min-h-0 flex-1"
      viewportProps={{ className: '[&>div]:!block' }}
    >
      <div className="p-3">
        {error && (
          <div role="alert" className="mb-3 text-sm text-destructive">
            {t(error)}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t('files.retry')}
            </Button>
          </div>
        )}
        {!data && !error ? (
          <div
            role="status"
            aria-label={t('files.loading')}
            className="space-y-3"
          >
            <Skeleton className="h-48 w-full rounded-lg" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
        ) : null}
        {data?.items.length === 0 && (
          <div className="px-3 py-16 text-center">
            <Images
              className="mx-auto mb-3 size-8 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm font-medium">
              {t(
                query.kind !== 'all' || query.search
                  ? 'assets.noMatches'
                  : 'assets.empty',
              )}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {t(
                query.kind !== 'all' || query.search
                  ? 'assets.filterHint'
                  : 'assets.emptyHint',
              )}
            </p>
          </div>
        )}
        {data && (
          <Masonry columnsCount={columns} gutter="12px">
            {data.items.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                selected={selected.some((item) => item.id === asset.id)}
                onSelect={(checked) => onSelect(asset, checked)}
              />
            ))}
          </Masonry>
        )}
        {data?.nextCursor && (
          <Button
            variant="outline"
            className="mt-4 w-full"
            disabled={loadingMore}
            onClick={() => void more()}
          >
            {t(loadingMore ? 'files.loading' : 'assets.loadMore')}
          </Button>
        )}
      </div>
    </ScrollArea>
  );
}
