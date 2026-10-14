import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, RefreshCw, Search, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import type { McpServer, McpToolDefinition } from '@aime/shared/mcp';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { mcpErrorKey } from '../api';

export function McpToolsSheet({
  server,
  onLoaded,
  onClose,
  restoreFocus,
}: {
  server: McpServer;
  onLoaded: (server: McpServer) => void;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const [tools, setTools] = useState<McpToolDefinition[]>();
  const [error, setError] = useState<TranslationKey>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void api.mcp
      .tools({ params: { id: server.id } }, { signal: controller.signal })
      .then(
        (data) => {
          if (controller.signal.aborted) return;
          setTools(data);
          setError(undefined);
          setLoading(false);
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          const message = mcpErrorKey(cause);
          setError(message);
          setLoading(false);
          toast.error(t(message));
        },
      );
    return () => controller.abort();
  }, [server.id, revision, t]);

  function refresh() {
    setLoading(true);
    setRevision((value) => value + 1);
  }
  async function reload() {
    setLoading(true);
    try {
      const loaded = await api.mcp.load({ params: { id: server.id } });
      onLoaded(loaded);
      toast.success(t('mcp.loadSuccess', { count: loaded.toolCount ?? 0 }));
      refresh();
    } catch (cause) {
      const message = mcpErrorKey(cause);
      setError(message);
      setLoading(false);
      toast.error(t(message));
    }
  }
  const query = search.trim().toLowerCase();
  const visible =
    tools?.filter((tool) =>
      `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(query),
    ) ?? [];

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="w-full gap-0 sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <div className="space-y-2 border-b px-5 pt-5 pb-4 pr-14 sm:px-6 sm:pr-14">
          <div className="flex items-center gap-2">
            <SheetTitle>{t('mcp.tools')}</SheetTitle>
            {tools ? <Badge variant="secondary">{tools.length}</Badge> : null}
          </div>
          <SheetDescription className="break-all">
            {server.name}
          </SheetDescription>
          <p className="text-xs text-muted-foreground">{t('mcp.toolsHint')}</p>
        </div>
        <div className="flex items-center gap-2 border-b px-5 py-3 sm:px-6">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              className="pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('mcp.toolsSearch')}
              aria-label={t('mcp.toolsSearch')}
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            disabled={loading}
            onClick={refresh}
            aria-label={t('mcp.toolsRefresh')}
          >
            <RefreshCw
              className={
                loading ? 'animate-spin motion-reduce:animate-none' : undefined
              }
            />
          </Button>
        </div>
        {error ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b px-5 py-3 text-sm text-destructive sm:px-6"
          >
            <span>{t(error)}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void reload()}
            >
              {t('mcp.load')}
            </Button>
          </div>
        ) : null}
        <ScrollArea
          className="min-h-0 flex-1"
          viewportProps={{ className: '[&>div]:block!', 'aria-busy': loading }}
        >
          {loading && !tools ? (
            <div
              role="status"
              aria-label={t('mcp.toolsLoading')}
              className="space-y-4 p-5 sm:p-6"
            >
              {[0, 1, 2].map((key) => (
                <Skeleton key={key} className="h-28 w-full" />
              ))}
            </div>
          ) : visible.length ? (
            <ul className="space-y-3 p-5 sm:p-6">
              {visible.map((tool) => (
                <li
                  key={tool.name}
                  className="min-w-0 overflow-hidden rounded-lg border bg-card"
                >
                  <div className="space-y-2 p-4">
                    <h3 className="break-all font-mono text-sm font-medium">
                      {tool.name}
                    </h3>
                    <p className="text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                      {tool.description || t('mcp.toolNoDescription')}
                    </p>
                  </div>
                  <Collapsible>
                    <CollapsibleTrigger
                      className="group flex w-full items-center justify-between gap-2 border-t px-4 py-2.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                      aria-label={t('mcp.toolParametersNamed', {
                        name: tool.name,
                      })}
                    >
                      {t('mcp.toolParameters')}
                      <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-4 border-t bg-muted/30 p-4">
                      <div className="space-y-2">
                        <h4 className="text-xs font-medium text-muted-foreground">
                          {t('mcp.toolInputSchema')}
                        </h4>
                        <pre className="font-mono text-xs leading-5 break-all whitespace-pre-wrap">
                          <code>
                            {JSON.stringify(tool.inputSchema, null, 2)}
                          </code>
                        </pre>
                      </div>
                      {tool.outputSchema !== undefined ? (
                        <div className="space-y-2">
                          <h4 className="text-xs font-medium text-muted-foreground">
                            {t('mcp.toolOutputSchema')}
                          </h4>
                          <pre className="font-mono text-xs leading-5 break-all whitespace-pre-wrap">
                            <code>
                              {JSON.stringify(tool.outputSchema, null, 2)}
                            </code>
                          </pre>
                        </div>
                      ) : null}
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              ))}
            </ul>
          ) : tools && !error ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <Wrench
                className="size-7 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="text-sm text-muted-foreground">
                {t(query ? 'mcp.toolsNoMatches' : 'mcp.toolsEmpty')}
              </p>
            </div>
          ) : null}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
