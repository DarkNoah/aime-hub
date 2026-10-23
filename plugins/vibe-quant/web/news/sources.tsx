import { useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Switch,
} from '@app/plugin-ui';
import { toast } from 'sonner';
import type { NewsOverview, NewsSourceView } from '../../news-types';
import { newsTime, newsError } from './format';
import { SourceEditor } from './source-editor';
import { Plus, Pencil, Trash2 } from 'lucide-react';

export function NewsSources({
  pluginId,
  overview,
  onUpdate,
  onRemove,
  onClose,
}: {
  pluginId: string;
  overview: NewsOverview;
  onUpdate(source: NewsSourceView): void;
  onRemove(id: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  const [editing, setEditing] = useState<NewsSourceView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<NewsSourceView | null>(null);
  async function toggle(source: NewsSourceView, enabled: boolean) {
    setPending((ids) => [...ids, source.id]);
    try {
      const result = await pluginRequest<NewsSourceView>(
        pluginId,
        `/news/sources/${source.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        },
      );
      onUpdate(result);
      toast.success(enabled ? '已启用资讯源' : '已停用资讯源');
    } catch {
      toast.error('更新资讯源失败，请重试');
    } finally {
      setPending((ids) => ids.filter((id) => id !== source.id));
    }
  }
  async function remove(source: NewsSourceView) {
    setPending((ids) => [...ids, source.id]);
    try {
      await pluginRequest(pluginId, `/news/sources/${source.id}`, {
        method: 'DELETE',
      });
      onRemove(source.id);
      setDeleting(null);
      toast.success('已删除资讯源，历史新闻已保留');
    } catch {
      toast.error('删除资讯源失败，请重试');
    } finally {
      setPending((ids) => ids.filter((id) => id !== source.id));
    }
  }
  const sources = overview.sources.filter((source) =>
    `${source.name} ${source.url}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b p-6">
          <SheetTitle>资讯源</SheetTitle>
          <SheetDescription>
            {overview.sources.length} 个 RSS 源 · {overview.industries.length}{' '}
            个行业。
            {overview.canManage
              ? '管理设置对所有用户生效。连续失败会自动停用并记录原因。'
              : '由管理员管理。连续失败会自动停用并记录原因。'}
          </SheetDescription>
        </SheetHeader>
        <div className="flex gap-2 p-4">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索资讯源"
            placeholder="搜索资讯源"
          />
          {overview.canManage ? (
            <Button className="shrink-0" onClick={() => setEditing('new')}>
              <Plus className="size-4" />
              新增
            </Button>
          ) : null}
        </div>
        <ScrollArea
          className="min-h-0 flex-1"
          viewportProps={{ className: '[&>div]:block!' }}
        >
          <div className="divide-y px-4 pb-6">
            {sources.map((source) => (
              <div key={source.id} className="space-y-2 py-4">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 break-words text-sm font-medium">
                    {source.name}
                  </span>
                  <Badge
                    variant={
                      source.autoDisabled
                        ? 'destructive'
                        : !source.enabled
                          ? 'outline'
                          : source.lastError || source.state?.error
                            ? 'destructive'
                            : 'secondary'
                    }
                  >
                    {source.autoDisabled
                      ? '失败停用'
                      : !source.enabled
                        ? '已停用'
                        : source.lastError || source.state?.error
                          ? '抓取失败'
                          : source.state?.lastSuccessAt
                            ? '正常'
                            : '等待采集'}
                  </Badge>
                  <Switch
                    aria-label={`启用 ${source.name}`}
                    checked={source.enabled}
                    disabled={
                      !overview.canManage || pending.includes(source.id)
                    }
                    onCheckedChange={(enabled) => void toggle(source, enabled)}
                  />
                  {overview.canManage ? (
                    <>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`编辑 ${source.name}`}
                        onClick={() => setEditing(source)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`删除 ${source.name}`}
                        onClick={() => setDeleting(source)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {source.contentMode === 'feed'
                    ? 'RSS 正文 · 无正文跳过 · '
                    : ''}
                  {
                    overview.industries.find(
                      (industry) => industry.key === source.industry,
                    )?.name
                  }{' '}
                  · 最近成功 {newsTime(source.state?.lastSuccessAt)} · 最近返回{' '}
                  {source.state?.itemCount ?? 0} 条
                </p>
                {source.lastError || source.state?.error ? (
                  <p className="text-xs text-destructive">
                    {newsError(source.lastError || source.state?.error || '')}
                    {source.autoDisabled
                      ? ` · 连续失败 ${source.failureCount} 次，已停止采集；重新启用可恢复。`
                      : source.lastError
                        ? ` · 正文连续失败 ${source.failureCount} 次，正在退避重试。`
                        : ` · 重试时间 ${newsTime(source.state?.nextPollAt)}`}
                  </p>
                ) : null}
                <a
                  className="block break-all text-xs text-muted-foreground underline underline-offset-4"
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {source.url}
                </a>
              </div>
            ))}
            {!sources.length ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                没有匹配的资讯源
              </p>
            ) : null}
          </div>
        </ScrollArea>
      </SheetContent>
      {editing ? (
        <SourceEditor
          pluginId={pluginId}
          source={editing === 'new' ? undefined : editing}
          industries={overview.industries}
          onSave={onUpdate}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !pending.includes(deleting.id)) setDeleting(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>删除「{deleting.name}」？</DialogTitle>
              <DialogDescription>
                删除后停止该 RSS 源的后续采集，已归档的新闻和正文会保留。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={pending.includes(deleting.id)}
                onClick={() => setDeleting(null)}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={pending.includes(deleting.id)}
                onClick={() => void remove(deleting)}
              >
                删除来源
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Sheet>
  );
}
