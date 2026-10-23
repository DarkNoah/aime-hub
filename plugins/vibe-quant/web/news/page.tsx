import { useEffect, useState } from 'react';
import { pluginRequest, type PluginPageProps } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@app/plugin-ui';
import { Newspaper, RefreshCw, Rss, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { NewsOverview, NewsPage } from '../../news-types';
import { NewsReader } from './article';
import { NewsSources } from './sources';
import { ContentBadge, newsTime } from './format';

export default function NewsPageView({ pluginId }: PluginPageProps) {
  const [overview, setOverview] = useState<NewsOverview | null>(null);
  const [overviewError, setOverviewError] = useState(false);
  const [industry, setIndustry] = useState('all');
  const [source, setSource] = useState('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await pluginRequest<NewsOverview>(
          pluginId,
          '/news/overview',
          { signal: abort.signal },
        );
        if (!abort.signal.aborted) {
          setOverview(result);
          setOverviewError(false);
        }
      } catch {
        if (!abort.signal.aborted) setOverviewError(true);
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(load, 15000);
      }
    }
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pluginId, refresh]);
  const industries = overview?.industries ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-6">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Newspaper className="size-5" />
            资讯
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            产业新闻与财经动态 · 来源、发布时间和正文持续归档
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={overviewError ? 'destructive' : 'secondary'}>
            {overviewError
              ? '连接异常'
              : !overview
                ? '连接中'
                : !overview.enabled
                  ? '采集已暂停'
                  : overview.collector.active
                    ? '自动采集中'
                    : '等待采集服务'}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            disabled={!overview}
            onClick={() => setSourcesOpen(true)}
          >
            <Rss className="size-4" />
            资讯源
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新新闻"
            onClick={() => setRefresh((v) => v + 1)}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-3 border-b bg-muted/15 px-4 py-3 sm:px-6">
        <Select
          value={industry}
          onValueChange={(value) => {
            setIndustry(value);
            setSource('all');
          }}
        >
          <SelectTrigger className="w-[180px]" aria-label="筛选行业">
            <SelectValue placeholder="全部行业" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部行业</SelectItem>
            {industries.map((item) => (
              <SelectItem key={item.key} value={item.key}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="w-[180px]" aria-label="筛选来源">
            <SelectValue placeholder="全部来源" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部来源</SelectItem>
            {overview?.sources
              .filter(
                (item) => industry === 'all' || item.industry === industry,
              )
              .map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <div className="relative min-w-[180px] flex-1">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label="搜索新闻"
            placeholder="搜索标题、摘要"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {overview ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b px-4 py-2 text-xs text-muted-foreground sm:px-6">
          <span>{overview.counts.total.toLocaleString()} 条资讯</span>
          <span>{overview.counts.ready.toLocaleString()} 条正文已保存</span>
          <span>{overview.counts.pending.toLocaleString()} 条等待正文</span>
          {overview.counts.failed ? (
            <span>{overview.counts.failed.toLocaleString()} 条正文待重试</span>
          ) : null}
          <span className="sm:ml-auto">
            每 {overview.pollSeconds} 秒检查资讯源 · 北京时间
          </span>
        </div>
      ) : null}
      <NewsList
        key={`${industry}:${source}:${search}`}
        pluginId={pluginId}
        industry={industry}
        source={source}
        query={search}
        refresh={refresh}
        onSelect={setSelected}
      />
      {selected ? (
        <NewsReader
          key={selected}
          pluginId={pluginId}
          id={selected}
          onClose={() => setSelected('')}
        />
      ) : null}
      {sourcesOpen && overview ? (
        <NewsSources
          pluginId={pluginId}
          overview={overview}
          onClose={() => setSourcesOpen(false)}
          onUpdate={(source) =>
            setOverview((old) =>
              old
                ? {
                    ...old,
                    sources: old.sources.some((item) => item.id === source.id)
                      ? old.sources.map((item) =>
                          item.id === source.id ? source : item,
                        )
                      : [source, ...old.sources],
                  }
                : old,
            )
          }
          onRemove={(id) => {
            setOverview((old) =>
              old
                ? {
                    ...old,
                    sources: old.sources.filter((item) => item.id !== id),
                  }
                : old,
            );
            if (source === id) setSource('all');
          }}
        />
      ) : null}
    </div>
  );
}

function NewsList({
  pluginId,
  industry,
  source,
  query,
  refresh,
  onSelect,
}: {
  pluginId: string;
  industry: string;
  source: string;
  query: string;
  refresh: number;
  onSelect(id: string): void;
}) {
  const [page, setPage] = useState<NewsPage | null>(null);
  const [fresh, setFresh] = useState<NewsPage | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const params = new URLSearchParams({
    ...(industry !== 'all' ? { industry } : {}),
    ...(source !== 'all' ? { source } : {}),
    ...(query ? { q: query } : {}),
  }).toString();
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await pluginRequest<NewsPage>(
          pluginId,
          `/news?${params}`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        setFresh(result);
        setPage((old) =>
          old
            ? {
                ...old,
                items: old.items.map(
                  (item) =>
                    result.items.find((latest) => latest.id === item.id) ??
                    item,
                ),
              }
            : result,
        );
        setError('');
      } catch {
        if (!abort.signal.aborted)
          setError('新闻暂时无法加载，请检查连接后重试。');
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(load, 15000);
      }
    }
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pluginId, params, refresh, retry]);
  const newItems = (fresh?.items ?? []).filter(
    (item) => !page?.items.some((old) => old.id === item.id),
  );
  async function loadMore() {
    if (!page?.nextCursor || more) return;
    setMore(true);
    try {
      const result = await pluginRequest<NewsPage>(
        pluginId,
        `/news?${params}&cursor=${page.nextCursor}`,
      );
      setPage((old) => ({
        ...result,
        items: [
          ...(old?.items ?? []),
          ...result.items.filter(
            (item) => !old?.items.some((v) => v.id === item.id),
          ),
        ],
      }));
    } catch {
      toast.error('加载更多新闻失败，请重试');
    } finally {
      setMore(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {newItems.length ? (
        <Button
          className="shrink-0 rounded-none"
          variant="secondary"
          onClick={() =>
            setPage((old) => {
              if (!old || !fresh) return old;
              // If the reader was away for more than one page of arrivals,
              // restart from the fresh cursor so no unseen interval is skipped.
              if (newItems.length === fresh.items.length) return fresh;
              return {
                ...old,
                items: [...newItems, ...old.items].sort(
                  (a, b) => b.sortAt - a.sortAt || b.id.localeCompare(a.id),
                ),
              };
            })
          }
        >
          有新资讯，点击显示
        </Button>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b px-6 py-3 text-sm"
        >
          <p className="text-destructive">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((v) => v + 1)}
          >
            重试
          </Button>
        </div>
      ) : null}
      <ScrollArea
        className="min-h-0 flex-1"
        viewportProps={{ className: '[&>div]:block!' }}
      >
        {!page && !error ? (
          <div className="space-y-6 p-6">
            {[0, 1, 2, 3, 4].map((key) => (
              <div key={key} className="space-y-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        ) : page?.items.length ? (
          <div className="divide-y">
            {page.items.map((item) => (
              <button
                key={item.id}
                className="block w-full space-y-2 px-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-2px] sm:px-6"
                onClick={() => onSelect(item.id)}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-primary">
                    {item.sourceName}
                  </span>
                  <span className="text-muted-foreground">
                    {item.publishedAt
                      ? newsTime(item.publishedAt)
                      : `发现于 ${newsTime(item.discoveredAt)}`}
                  </span>
                  <span className="ml-auto">
                    <ContentBadge article={item} />
                  </span>
                </div>
                <h2 className="text-base leading-relaxed font-medium [overflow-wrap:anywhere]">
                  {item.title}
                </h2>
                {item.summary ? (
                  <p className="line-clamp-2 max-w-[95ch] text-sm leading-relaxed text-muted-foreground">
                    {item.summary}
                  </p>
                ) : null}
              </button>
            ))}
          </div>
        ) : page ? (
          <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
            <Newspaper className="size-8 text-muted-foreground" />
            <h2 className="font-medium">
              {query || industry !== 'all' || source !== 'all'
                ? '没有匹配的新闻'
                : '等待第一批资讯'}
            </h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              {query || industry !== 'all' || source !== 'all'
                ? '试试其他关键词，或切换行业与来源。'
                : '后台会持续读取资讯源。可以在「资讯源」中查看抓取状态。'}
            </p>
          </div>
        ) : null}
        {page?.nextCursor ? (
          <div className="p-6 text-center">
            <Button
              variant="outline"
              disabled={more}
              onClick={() => void loadMore()}
            >
              {more ? '加载中…' : '加载更多'}
            </Button>
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}
