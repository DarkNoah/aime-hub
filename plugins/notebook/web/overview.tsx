import type { PluginPageProps, PluginSidebarProps } from '@app/plugin-sdk/web';
import { Badge, Button, PageHeader, ScrollArea } from '@app/plugin-ui';
import { useNotes } from './use-notes';

export function NotebookOverview({ pluginId }: PluginSidebarProps) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <OverviewContent pluginId={pluginId} />
    </ScrollArea>
  );
}

export function NotebookOverviewPage({ pluginId }: PluginPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="笔记概览"
        description="了解最近的记录，与聊天右侧栏中的概览共用数据。"
      />
      <div className="max-w-3xl rounded-xl border bg-card">
        <OverviewContent pluginId={pluginId} />
      </div>
    </div>
  );
}

function OverviewContent({ pluginId }: { pluginId: string }) {
  const { notes, loading, error, reload } = useNotes(pluginId);
  const characters = notes.reduce(
    (sum, note) => sum + Array.from(note.content).length,
    0,
  );
  return (
    <div className="space-y-5 p-4">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="secondary">最近 50 条</Badge>
        <Button variant="outline" size="sm" onClick={reload}>
          刷新概览
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        汇总你自己的笔记，切换到「个人笔记」可继续记录。
      </p>
      {loading ? (
        <p role="status" className="text-sm">
          正在加载笔记…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">
          读取失败，请刷新重试。
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border bg-background p-4">
              <dt className="text-xs text-muted-foreground">笔记数</dt>
              <dd className="mt-2 text-2xl font-semibold tabular-nums">
                {notes.length}
              </dd>
            </div>
            <div className="rounded-xl border bg-background p-4">
              <dt className="text-xs text-muted-foreground">内容字数</dt>
              <dd className="mt-2 text-2xl font-semibold tabular-nums">
                {characters}
              </dd>
            </div>
          </dl>
          <section className="space-y-3">
            <h3 className="text-sm font-medium">最近记录</h3>
            {notes.length ? (
              notes.slice(0, 5).map((note) => (
                <article
                  key={note.id}
                  className="space-y-2 rounded-xl border p-4"
                >
                  <h4 className="truncate text-sm font-medium">{note.title}</h4>
                  <p className="line-clamp-3 text-xs leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                    {note.content}
                  </p>
                </article>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                暂无笔记，从第一条记录开始。
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
