import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Download } from 'lucide-react';
import type {
  KnowledgeDocument,
  KnowledgeVersion,
  KnowledgeVersionDetail,
} from '@aime/shared/knowledge';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { FileDiff } from '@/components/file-diff';
import { TagsDisplay } from './tags-editor';
import { knowledgeError } from './errors';

export function VersionSheet({
  document,
  onClose,
}: {
  document: KnowledgeDocument;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [before, setBefore] = useState<number>();
  const [oldVersion, setOldVersion] = useState(
    Math.max(1, document.version - 1),
  );
  const [newVersion, setNewVersion] = useState(document.version);
  const [details, setDetails] = useState<{
    old: KnowledgeVersionDetail;
    next: KnowledgeVersionDetail;
  }>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    void api.knowledge
      .versions({ id: document.id }, { signal: c.signal })
      .then((page) => {
        setVersions(page.versions);
        setBefore(page.nextBefore);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
  }, [document.id, document.updatedAt, retry]);
  useEffect(() => {
    const c = new AbortController();
    void Promise.all([
      api.knowledge.version(
        { id: document.id, version: oldVersion },
        { signal: c.signal },
      ),
      api.knowledge.version(
        { id: document.id, version: newVersion },
        { signal: c.signal },
      ),
    ])
      .then(([old, next]) => {
        if (!c.signal.aborted) {
          setDetails({ old, next });
          setError(undefined);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
  }, [document.id, document.updatedAt, oldVersion, newVersion, retry]);
  async function loadMore() {
    setBusy(true);
    try {
      const page = await api.knowledge.versions({ id: document.id, before });
      setVersions((current) => [
        ...current,
        ...page.versions.filter(
          (v) => !current.some((c) => c.version === v.version),
        ),
      ]);
      setBefore(page.nextBefore);
    } catch (e) {
      toast.error(t(knowledgeError(e)));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    try {
      const file = await api.knowledge.versionFile({
        id: document.id,
        version: newVersion,
      });
      const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes]));
      const link = window.document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error(t(knowledgeError(e)));
    } finally {
      setBusy(false);
    }
  }
  const loaded =
    details?.old.version === oldVersion && details.next.version === newVersion;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="flex w-full flex-col sm:max-w-5xl">
        <div className="space-y-2 border-b px-6 py-5 pr-14">
          <SheetTitle>
            {t('knowledge.versionHistory')} · {document.name}
          </SheetTitle>
          <SheetDescription>
            {t('knowledge.versionHistoryHint')}
          </SheetDescription>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 px-4 pb-6">
            <div className="flex flex-wrap gap-3">
              {(['old', 'next'] as const).map((side) => (
                <div key={side} className="min-w-40 flex-1 space-y-2">
                  <p className="text-sm">
                    {t(
                      side === 'old'
                        ? 'knowledge.compareBefore'
                        : 'knowledge.compareAfter',
                    )}
                  </p>
                  <Select
                    value={String(side === 'old' ? oldVersion : newVersion)}
                    onValueChange={(v) =>
                      side === 'old'
                        ? setOldVersion(Number(v))
                        : setNewVersion(Number(v))
                    }
                  >
                    <SelectTrigger
                      aria-label={t(
                        side === 'old'
                          ? 'knowledge.compareBefore'
                          : 'knowledge.compareAfter',
                      )}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {versions.map((v) => (
                        <SelectItem key={v.version} value={String(v.version)}>
                          v{v.version} · {v.name}
                          {v.isCurrent
                            ? ` · ${t('knowledge.currentVersion')}`
                            : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {before && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void loadMore()}
              >
                {t('knowledge.loadMore')}
              </Button>
            )}
            {error ? (
              <div role="alert">
                {t(knowledgeError(error))}
                <Button variant="ghost" onClick={() => setRetry((v) => v + 1)}>
                  {t('knowledge.retry')}
                </Button>
              </div>
            ) : !loaded ? (
              <p role="status">{t('knowledge.loading')}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="space-y-2">
                    <Badge variant="outline">v{details.next.version}</Badge>
                    <p className="text-xs text-muted-foreground">
                      {t('knowledge.createdBy')}: {details.next.createdBy} ·{' '}
                      {new Date(details.next.createdAt).toLocaleString()}
                    </p>
                    <TagsDisplay tags={details.next.tags} />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void download()}
                  >
                    <Download />
                    {t('knowledge.downloadVersion')}
                  </Button>
                </div>
                <Tabs defaultValue="diff">
                  <TabsList>
                    <TabsTrigger value="diff">
                      {t('knowledge.versionDiff')}
                    </TabsTrigger>
                    <TabsTrigger value="content">
                      {t('knowledge.content')}
                    </TabsTrigger>
                    <TabsTrigger value="metadata">
                      {t('knowledge.metadata')}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="diff">
                    {details.next.status === 'pending' ||
                    details.next.status === 'processing' ? (
                      <p role="status">{t('knowledge.diffPending')}</p>
                    ) : (
                      <FileDiff
                        filename="document.txt"
                        oldValue={details.old.content}
                        newValue={details.next.content}
                      />
                    )}
                  </TabsContent>
                  <TabsContent value="content">
                    <p className="whitespace-pre-wrap break-words text-sm leading-7">
                      {details.next.content || t('knowledge.notReady')}
                    </p>
                  </TabsContent>
                  <TabsContent value="metadata">
                    <FileDiff
                      filename="metadata.json"
                      oldValue={JSON.stringify(
                        {
                          name: details.old.name,
                          tags: details.old.tags,
                          metadata: details.old.metadata,
                        },
                        null,
                        2,
                      )}
                      newValue={JSON.stringify(
                        {
                          name: details.next.name,
                          tags: details.next.tags,
                          metadata: details.next.metadata,
                        },
                        null,
                        2,
                      )}
                    />
                  </TabsContent>
                </Tabs>
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
