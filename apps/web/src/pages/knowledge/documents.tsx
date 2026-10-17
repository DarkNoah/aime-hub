import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  FileText,
  History,
  FileUp,
  ArchiveRestore,
  Globe,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react';
import type {
  KnowledgeBase,
  KnowledgeTags,
  KnowledgeMetadata,
  KnowledgeDocument,
  KnowledgeCursor,
} from '@aime/shared/knowledge';
import { knowledgeLocked } from '@aime/shared/knowledge';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ImportDialog } from './import-dialog';
import { EditDocumentDialog } from './edit-document-dialog';
import { DocumentSheet } from './document-sheet';
import { VersionSheet } from './version-sheet';
import { TagsDisplay } from './tags-editor';
import { KnowledgeSearch } from './search';
import { knowledgeError } from './errors';

export function KnowledgeDocuments({ base }: { base: KnowledgeBase }) {
  const { t } = useTranslation();
  const locked = knowledgeLocked(base) || !base.canEditDocuments;
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [page, setPage] = useState(-1);
  const [cursor, setCursor] = useState<KnowledgeCursor>();
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [newVersion, setNewVersion] = useState(false);
  const [history, setHistory] = useState<KnowledgeDocument>();
  const [archived, setArchived] = useState(false);
  const [filterTags, setFilterTags] = useState<KnowledgeTags>({});
  const [filterMetadata, setFilterMetadata] = useState<KnowledgeMetadata>({});
  const [facets, setFacets] = useState<KnowledgeTags>({});
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<string>();
  const [deleting, setDeleting] = useState<KnowledgeDocument>();
  const [busy, setBusy] = useState<string>();
  const alive = useRef(true);
  const requestRevision = useRef(0);
  useEffect(() => {
    alive.current = true;
    const c = new AbortController();
    void api.knowledge
      .documents(
        { id: base.id, archived, tags: filterTags, metadata: filterMetadata },
        { signal: c.signal },
      )
      .then((v) => {
        setDocs(v.documents);
        setMore(v.hasMore);
        setCursor(v.nextCursor);
        setPage(0);
        setError(undefined);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => {
      alive.current = false;
      c.abort();
    };
  }, [base.id, archived, filterTags, filterMetadata]);
  useEffect(() => {
    const c = new AbortController();
    void api.knowledge
      .tags({ id: base.id }, { signal: c.signal })
      .then(setFacets)
      .catch(() => {});
    return () => c.abort();
  }, [base.id, revision]);
  function resetList() {
    requestRevision.current++;
    setDocs([]);
    setPage(-1);
    setCursor(undefined);
    setMore(false);
    setLoading(true);
  }
  const pendingIds = docs
    .filter(
      (d) =>
        !d.deletedAt && (d.status === 'pending' || d.status === 'processing'),
    )
    .map((d) => d.id)
    .slice(0, 100)
    .join(',');
  useEffect(() => {
    if (!pendingIds) return;
    const c = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const updates = await api.knowledge.statuses(
          { id: base.id, ids: pendingIds.split(',') },
          { signal: c.signal },
        );
        if (!c.signal.aborted) {
          const map = new Map(updates.map((d) => [d.id, d]));
          setDocs((current) => current.map((d) => map.get(d.id) ?? d));
          setError(undefined);
        }
      } catch (e) {
        if (!c.signal.aborted) setError(e);
      } finally {
        if (!c.signal.aborted) timeout = setTimeout(() => void poll(), 2500);
      }
    }
    timeout = setTimeout(() => void poll(), 1500);
    return () => {
      c.abort();
      clearTimeout(timeout);
    };
  }, [base.id, pendingIds]);
  function update(doc: KnowledgeDocument) {
    setDocs((current) => current.map((d) => (d.id === doc.id ? doc : d)));
  }
  async function mutate(
    id: string,
    action: () => Promise<KnowledgeDocument | void>,
    reprocessing = false,
  ) {
    if (busy || locked) return;
    setBusy(id);
    try {
      const doc = await action();
      if (alive.current) {
        if (doc && !!doc.deletedAt === archived) update(doc);
        else setDocs((current) => current.filter((d) => d.id !== id));
        setDeleting(undefined);
      }
      setRevision((v) => v + 1);
      toast.success(
        t(
          reprocessing
            ? base.embeddingModel
              ? 'knowledge.embeddingQueued'
              : 'knowledge.queued'
            : 'knowledge.saved',
        ),
      );
    } catch (e) {
      toast.error(t(knowledgeError(e)));
    } finally {
      if (alive.current) setBusy(undefined);
    }
  }
  async function loadMore() {
    const revision = requestRevision.current;
    setLoading(true);
    try {
      const result = await api.knowledge.documents({
        id: base.id,
        cursor,
        archived,
        tags: filterTags,
        metadata: filterMetadata,
      });
      if (alive.current && requestRevision.current === revision) {
        setDocs((current) => [
          ...current,
          ...result.documents.filter(
            (d) => !current.some((old) => old.id === d.id),
          ),
        ]);
        setPage(page + 1);
        setMore(result.hasMore);
        setCursor(result.nextCursor);
        setError(undefined);
      }
    } catch (e) {
      if (requestRevision.current === revision) setError(e);
    } finally {
      if (alive.current && requestRevision.current === revision)
        setLoading(false);
    }
  }
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <h2 className="break-words text-xl font-semibold">{base.name}</h2>
          <p className="text-sm text-muted-foreground">
            {base.description || t('knowledge.documentsHint')}
          </p>
          <Badge variant="outline">
            {base.embeddingModel ? t('knowledge.hybrid') : t('knowledge.bm25')}
          </Badge>
          {!base.enabled && (
            <Badge variant="secondary" className="ml-2">
              {t('knowledge.disabled')}
            </Badge>
          )}
        </div>
        {base.canEditDocuments && (
          <Button onClick={() => setImporting(true)} disabled={locked}>
            <Plus />
            {t('knowledge.import')}
          </Button>
        )}
      </div>
      {base.rebuild && (
        <div
          role="status"
          className="space-y-2 rounded-lg border bg-muted/40 p-4"
        >
          <Badge
            variant={
              base.rebuild.status === 'failed' ? 'destructive' : 'secondary'
            }
          >
            {t(
              base.rebuild.status === 'failed'
                ? 'knowledge.rebuildFailed'
                : 'knowledge.rebuilding',
            )}
          </Badge>
          <p className="text-sm">
            {knowledgeLocked(base)
              ? t('knowledge.rebuildProgress', {
                  completed: base.rebuild.completed,
                  total: base.rebuild.total,
                })
              : t(knowledgeError(base.rebuild.error ?? ''))}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              knowledgeLocked(base)
                ? 'knowledge.rebuildLockHint'
                : 'knowledge.rebuildRetryHint',
            )}
          </p>
        </div>
      )}
      <Tabs
        defaultValue="documents"
        onValueChange={(value) => {
          if (value === 'documents' || value === 'archived') {
            const next = value === 'archived';
            if (next !== archived) {
              resetList();
              setArchived(next);
            }
          }
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList className="shrink-0">
            <TabsTrigger value="documents">
              {t('knowledge.documents')}
            </TabsTrigger>
            <TabsTrigger value="archived">
              {t('knowledge.archived')}
            </TabsTrigger>
          </TabsList>
          <KnowledgeSearch
            base={base}
            tags={filterTags}
            metadata={filterMetadata}
            onMetadataChange={(value) => {
              resetList();
              setFilterMetadata(value);
            }}
            onPreview={setPreview}
          />
        </div>
        <TabsContent
          value={archived ? 'archived' : 'documents'}
          className="space-y-3"
        >
          {Object.keys(facets).length > 0 && (
            <div
              className="space-y-3 border-b pb-4"
              role="group"
              aria-label={t('knowledge.tagFilters')}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {t('knowledge.tagFilters')}
                </span>
                {Object.keys(filterTags).length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      resetList();
                      setFilterTags({});
                    }}
                  >
                    {t('knowledge.clearTagFilters')}
                  </Button>
                )}
              </div>
              {Object.entries(facets).map(([dimension, values]) => (
                <div
                  key={dimension}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="mr-1 text-sm text-muted-foreground">
                    {dimension}
                  </span>
                  {values.map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      className="h-7 rounded-full px-3 text-xs"
                      variant={
                        filterTags[dimension]?.includes(value)
                          ? 'secondary'
                          : 'outline'
                      }
                      aria-pressed={!!filterTags[dimension]?.includes(value)}
                      onClick={() => {
                        resetList();
                        setFilterTags((current) => {
                          const next = { ...current };
                          const values = next[dimension] ?? [];
                          const selected = values.includes(value)
                            ? values.filter((v) => v !== value)
                            : [...values, value];
                          if (selected.length) next[dimension] = selected;
                          else delete next[dimension];
                          return next;
                        });
                      }}
                    >
                      {value}
                    </Button>
                  ))}
                </div>
              ))}
            </div>
          )}
          {!!error && (
            <div
              role="alert"
              className="flex items-center gap-3 text-sm text-destructive"
            >
              {t(knowledgeError(error))}
              {page < 0 && (
                <Button
                  variant="outline"
                  onClick={() => void loadMore()}
                  disabled={loading}
                >
                  {t('knowledge.retry')}
                </Button>
              )}
            </div>
          )}
          {!loading && !docs.length && !error && (
            <div className="rounded-lg border border-dashed px-6 py-16 text-center">
              <FileText className="mx-auto mb-3 size-8 text-muted-foreground" />
              <p>{t('knowledge.noDocuments')}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t('knowledge.importHint')}
              </p>
            </div>
          )}
          {(docs.length > 0 || loading || more) && (
            <ScrollArea className="h-[min(58vh,650px)]">
              <div className="space-y-2 pr-3">
                {docs.map((d) => (
                  <div
                    key={d.id}
                    className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-lg border p-4 sm:flex"
                  >
                    {d.sourceType === 'url' ? (
                      <Globe className="mt-1 size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileText className="mt-1 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <button
                        onClick={() => setPreview(d.id)}
                        className="text-left text-sm font-medium hover:underline [overflow-wrap:anywhere]"
                      >
                        {d.name}
                      </button>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            d.status === 'failed'
                              ? 'destructive'
                              : d.status === 'ready'
                                ? 'secondary'
                                : 'outline'
                          }
                        >
                          {t(
                            d.deletedAt
                              ? 'knowledge.archived'
                              : d.status === 'processing' && base.embeddingModel
                                ? 'knowledge.embeddingProcessing'
                                : `knowledge.${d.status}`,
                          )}
                        </Badge>
                        <Badge variant="outline">v{d.version}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {t('knowledge.chunks', { count: d.chunkCount })}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t('knowledge.createdBy')}: {d.createdBy} ·{' '}
                        {t('knowledge.updatedAt')}:{' '}
                        {new Date(d.updatedAt).toLocaleString()}
                      </p>
                      <TagsDisplay tags={d.tags} />
                      {d.error && (
                        <p className="mt-2 text-xs text-destructive">
                          {t(knowledgeError(d.error))}
                        </p>
                      )}
                    </div>
                    <div className="col-span-2 flex flex-wrap items-center justify-end gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t('knowledge.historyNamed', {
                          name: d.name,
                        })}
                        title={t('knowledge.versionHistory')}
                        onClick={() => setHistory(d)}
                      >
                        <History />
                      </Button>
                      {base.canEditDocuments && d.deletedAt && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={locked || !!busy}
                          onClick={() =>
                            void mutate(
                              d.id,
                              () => api.knowledge.restoreDocument({ id: d.id }),
                              true,
                            )
                          }
                        >
                          <ArchiveRestore />
                          {t('knowledge.restore')}
                        </Button>
                      )}
                      {base.canEditDocuments && !d.deletedAt && (
                        <div className="flex shrink-0 flex-wrap items-center gap-1">
                          <Switch
                            checked={d.enabled}
                            disabled={
                              locked || !!busy || d.status === 'processing'
                            }
                            aria-label={t('knowledge.toggleDocument', {
                              name: d.name,
                            })}
                            onCheckedChange={(enabled) =>
                              void mutate(d.id, () =>
                                api.knowledge.setDocumentEnabled({
                                  id: d.id,
                                  enabled,
                                }),
                              )
                            }
                          />
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={
                              locked || !!busy || d.status === 'processing'
                            }
                            aria-label={t('knowledge.editNamedDocument', {
                              name: d.name,
                            })}
                            title={t('knowledge.editDocument')}
                            onClick={() => {
                              setNewVersion(false);
                              setEditing(d.id);
                            }}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={
                              locked ||
                              !!busy ||
                              d.status === 'pending' ||
                              d.status === 'processing'
                            }
                            aria-label={t('knowledge.updateVersionNamed', {
                              name: d.name,
                            })}
                            title={t('knowledge.updateVersion')}
                            onClick={() => {
                              setNewVersion(true);
                              setEditing(d.id);
                            }}
                          >
                            <FileUp />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={
                              locked ||
                              !!busy ||
                              d.status === 'pending' ||
                              d.status === 'processing'
                            }
                            aria-label={t('knowledge.reprocessNamed', {
                              name: d.name,
                            })}
                            title={t(
                              base.embeddingModel
                                ? 'knowledge.reembed'
                                : 'knowledge.reprocess',
                            )}
                            onClick={() =>
                              void mutate(
                                d.id,
                                () => api.knowledge.retry({ id: d.id }),
                                true,
                              )
                            }
                          >
                            <RotateCw />
                          </Button>

                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={
                              locked || !!busy || d.status === 'processing'
                            }
                            aria-label={t('knowledge.deleteDocument', {
                              name: d.name,
                            })}
                            onClick={() => setDeleting(d)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {loading && (
                  <p
                    role="status"
                    className="p-4 text-sm text-muted-foreground"
                  >
                    {t('knowledge.loading')}
                  </p>
                )}
                {more && (
                  <Button
                    variant="outline"
                    disabled={loading}
                    onClick={() => void loadMore()}
                  >
                    {t('knowledge.loadMore')}
                  </Button>
                )}
              </div>
            </ScrollArea>
          )}
        </TabsContent>
      </Tabs>
      {importing && (
        <ImportDialog
          locked={locked}
          baseId={base.id}
          fields={base.fields}
          embeddingEnabled={!!base.embeddingModel}
          onClose={() => setImporting(false)}
          onImported={(d) => {
            setRevision((v) => v + 1);
            if (!archived) setDocs((current) => [d, ...current]);
          }}
        />
      )}
      {editing && (
        <EditDocumentDialog
          key={editing}
          id={editing}
          base={base}
          newVersion={newVersion}
          locked={locked}
          onClose={() => setEditing(undefined)}
          onSaved={(updated) => {
            setRevision((v) => v + 1);
            setDocs((current) =>
              current.map((d) => (d.id === updated.id ? updated : d)),
            );
          }}
        />
      )}
      {history && (
        <VersionSheet
          key={history.id}
          document={docs.find((d) => d.id === history.id) ?? history}
          onClose={() => setHistory(undefined)}
        />
      )}
      {preview && (
        <DocumentSheet
          key={preview}
          id={preview}
          onClose={() => setPreview(undefined)}
        />
      )}
      {deleting && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setDeleting(undefined);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('knowledge.archive')}</DialogTitle>
              <DialogDescription>
                {t('knowledge.deleteDocumentHint', { name: deleting.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => setDeleting(undefined)}
              >
                {t('knowledge.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={locked || !!busy}
                onClick={() =>
                  void mutate(deleting.id, () =>
                    api.knowledge.removeDocument({ id: deleting.id }),
                  )
                }
              >
                {t('knowledge.archive')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
