import { useEffect, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  MarkdownContent,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from '@app/plugin-ui';
import { ExternalLink } from 'lucide-react';
import type { NewsArticle } from '../../news-types';
import { ContentBadge, newsTime, newsError } from './format';

export function NewsReader({
  pluginId,
  id,
  onClose,
}: {
  pluginId: string;
  id: string;
  onClose(): void;
}) {
  const [article, setArticle] = useState<NewsArticle | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const item = await pluginRequest<NewsArticle>(pluginId, `/news/${id}`, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setArticle(item);
        setError('');
        if (item.contentStatus !== 'ready') timer = setTimeout(load, 10000);
      } catch {
        if (!abort.signal.aborted) setError('正文暂时无法加载，请重试。');
      }
    }
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pluginId, id, retry]);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="shrink-0 border-b p-6 pr-12">
          <SheetTitle className="text-xl leading-relaxed">
            {article?.title ?? '读取新闻'}
          </SheetTitle>
          <SheetDescription>
            {article
              ? `${article.sourceName} · 发布时间 ${newsTime(article.publishedAt)}（北京时间）`
              : '正在读取已保存的内容'}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea
          className="min-h-0 flex-1"
          viewportProps={{ className: '[&>div]:block!' }}
        >
          <div className="mx-auto max-w-[75ch] space-y-5 p-6">
            {error ? (
              <div role="alert" className="space-y-3">
                <p>{error}</p>
                <Button
                  variant="outline"
                  onClick={() => setRetry((v) => v + 1)}
                >
                  重新加载
                </Button>
              </div>
            ) : !article ? (
              <div className="space-y-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <ContentBadge article={article} />
                  <Badge variant="outline">
                    发现于 {newsTime(article.discoveredAt)}
                  </Badge>
                  <a
                    className="ml-auto inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4"
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    查看原文
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
                {article.contentStatus === 'ready' &&
                !article.contentTruncated ? (
                  <>
                    <MarkdownContent
                      renderEnhancedLinks={false}
                      isAnimating={false}
                    >
                      {article.content}
                    </MarkdownContent>
                    <p className="border-t pt-4 text-xs text-muted-foreground">
                      正文读取：{article.contentProvider} · 保存于{' '}
                      {newsTime(article.contentFetchedAt)}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="rounded-md bg-muted/50 p-3 text-sm">
                      {article.contentStatus === 'failed'
                        ? `${newsError(article.contentError)}。可在「资讯源」查看采集状态；已自动停用的来源需重新启用。`
                        : '后台正在抓取正文，完成后会自动显示。以下为资讯源摘要。'}
                    </p>
                    <h2 className="text-sm font-medium">资讯源摘要</h2>
                    <p className="whitespace-pre-wrap text-sm leading-7">
                      {article.summary || '资讯源未提供摘要，可打开原文阅读。'}
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
