import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  BookOpen,
  Pencil,
  Plus,
  Trash2,
  Share2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  knowledgeLocked,
  type KnowledgeBase,
  type KnowledgeScope,
} from '@aime/shared/knowledge';
import { api, apiErrorCode } from '@/lib/rpc';
import { SharingDialog } from './sharing-dialog';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { BaseDialog } from './base-dialog';
import { KnowledgeDocuments } from './documents';
import { knowledgeError } from './errors';

export function KnowledgePage() {
  const { projectId } = useParams({ strict: false });
  const { t } = useTranslation();
  const [scope, setScope] = useState<'personal' | 'shared'>('personal');
  return (
    <div className="space-y-6">
      {projectId && (
        <Button asChild variant="ghost" size="sm">
          <Link to="/projects/$projectId" params={{ projectId }}>
            <ArrowLeft />
            {t('projects.dashboard')}
          </Link>
        </Button>
      )}
      <PageHeader
        title={t('nav.knowledge')}
        description={t(
          projectId ? 'knowledge.projectHint' : 'knowledge.pageHint',
        )}
      />
      {!projectId && (
        <Tabs value={scope} onValueChange={(s) => setScope(s as typeof scope)}>
          <TabsList>
            <TabsTrigger value="personal">
              {t('knowledge.personal')}
            </TabsTrigger>
            <TabsTrigger value="shared">{t('knowledge.shared')}</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <KnowledgeManager
        key={projectId ?? scope}
        scope={projectId ? { scope: 'project', projectId } : { scope }}
      />
    </div>
  );
}
function KnowledgeManager({ scope }: { scope: KnowledgeScope }) {
  const { t } = useTranslation();
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<KnowledgeBase | 'new'>();
  const [sharing, setSharing] = useState<KnowledgeBase>();
  const [deleting, setDeleting] = useState<KnowledgeBase>();
  const [busy, setBusy] = useState(false);
  const rebuildStates = useRef(new Map<string, boolean>());
  // The parent keys the manager by scope, preserving requests and dialogs within a scope.
  const [initialScope] = useState(scope);
  useEffect(() => {
    const c = new AbortController();
    void api.knowledge
      .list(initialScope, { signal: c.signal })
      .then((v) => {
        for (const b of v.bases)
          rebuildStates.current.set(b.id, knowledgeLocked(b));
        setBases(v.bases);
        setCanManage(v.canManage);
        setSelected((id) => id ?? v.bases[0]?.id);
        setError(undefined);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [initialScope, retry]);
  const pollingIds = [
    ...new Set([selected, ...bases.filter(knowledgeLocked).map((b) => b.id)]),
  ]
    .filter(Boolean)
    .join(',');
  useEffect(() => {
    if (!pollingIds) return;
    const c = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const updates = await Promise.allSettled(
        pollingIds
          .split(',')
          .map((id) => api.knowledge.get({ id }, { signal: c.signal })),
      );
      if (c.signal.aborted) return;
      const successful: KnowledgeBase[] = [];
      const removed = new Set(
        updates.flatMap((result, index) =>
          result.status === 'rejected' &&
          ['KNOWLEDGE_NOT_FOUND', 'FORBIDDEN', 'PROJECT_NOT_FOUND'].includes(
            apiErrorCode(result.reason) ?? '',
          )
            ? [pollingIds.split(',')[index]!]
            : [],
        ),
      );
      if (removed.size) {
        setSelected((id) => (id && removed.has(id) ? undefined : id));
        setEditing((current) =>
          current && current !== 'new' && removed.has(current.id)
            ? undefined
            : current,
        );
        setSharing((current) =>
          current && removed.has(current.id) ? undefined : current,
        );
        setDeleting((current) =>
          current && removed.has(current.id) ? undefined : current,
        );
      }
      for (const result of updates)
        if (result.status === 'fulfilled') {
          const b = result.value;
          if (rebuildStates.current.get(b.id) && !knowledgeLocked(b)) {
            if (b.rebuild?.status === 'failed')
              toast.error(t('knowledge.rebuildFailed'));
            else toast.success(t('knowledge.rebuildDone'));
          }
          rebuildStates.current.set(b.id, knowledgeLocked(b));
          successful.push(b);
        }
      setBases((current) =>
        current
          .filter((b) => !removed.has(b.id))
          .map((b) => successful.find((u) => u.id === b.id) ?? b),
      );
      timer = setTimeout(() => void poll(), 2500);
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [pollingIds, t]);
  function saved(base: KnowledgeBase) {
    rebuildStates.current.set(base.id, knowledgeLocked(base));
    setBases((current) =>
      current.some((b) => b.id === base.id)
        ? current.map((b) => (b.id === base.id ? base : b))
        : [base, ...current],
    );
    setSelected(base.id);
  }
  async function remove() {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await api.knowledge.remove({ id: deleting.id });
      setBases((current) => current.filter((b) => b.id !== deleting.id));
      if (selected === deleting.id)
        setSelected(bases.find((b) => b.id !== deleting.id)?.id);
      setDeleting(undefined);
      toast.success(t('knowledge.saved'));
    } catch (e) {
      toast.error(t(knowledgeError(e)));
    } finally {
      setBusy(false);
    }
  }
  async function toggle(base: KnowledgeBase, enabled: boolean) {
    setBusy(true);
    try {
      const updated = await api.knowledge.update({
        id: base.id,
        data: { enabled },
      });
      setBases((current) =>
        current.map((b) => (b.id === updated.id ? updated : b)),
      );
      toast.success(t('knowledge.saved'));
    } catch (e) {
      toast.error(t(knowledgeError(e)));
    } finally {
      setBusy(false);
    }
  }
  const base = bases.find((b) => b.id === selected);
  if (loading) return <p role="status">{t('knowledge.loading')}</p>;
  if (error)
    return (
      <div role="alert" className="space-y-3">
        <p>{t(knowledgeError(error))}</p>
        <Button
          variant="outline"
          onClick={() => {
            setLoading(true);
            setRetry((n) => n + 1);
          }}
        >
          {t('knowledge.retry')}
        </Button>
      </div>
    );
  return (
    <>
      <div className="grid min-w-0 gap-7 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <BookOpen className="size-4" />
              {t(`knowledge.${scope.scope}`)}
              <Badge variant="secondary">{bases.length}</Badge>
            </h2>
            {canManage && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('knowledge.create')}
                onClick={() => setEditing('new')}
              >
                <Plus />
              </Button>
            )}
          </div>
          <ScrollArea className="max-h-[65vh]">
            <div className="space-y-2 pr-2">
              {bases.map((b) => (
                <div
                  key={b.id}
                  className={cn(
                    'rounded-lg border p-3',
                    selected === b.id
                      ? 'border-primary/30 bg-primary/5'
                      : 'border-transparent hover:bg-muted/50',
                  )}
                >
                  <button
                    aria-pressed={selected === b.id}
                    className="w-full text-left"
                    onClick={() => setSelected(b.id)}
                  >
                    <p className="break-words text-sm font-medium">{b.name}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {b.description ||
                        t(
                          b.embeddingModel
                            ? 'knowledge.hybrid'
                            : 'knowledge.bm25',
                        )}
                    </p>
                  </button>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {b.scope !== 'project' && (
                      <Badge variant="outline">
                        {t(`knowledge.sharing.${b.sharingMode}`)}
                      </Badge>
                    )}
                    <Badge variant="secondary">
                      {t(`knowledge.permission.${b.permission}`)}
                    </Badge>
                  </div>
                  {b.canManage ? (
                    <div className="mt-3 flex items-center justify-between">
                      <Switch
                        checked={b.enabled}
                        disabled={busy || knowledgeLocked(b)}
                        aria-label={t('knowledge.toggleBase', { name: b.name })}
                        onCheckedChange={(enabled) => void toggle(b, enabled)}
                      />
                      <div className="flex">
                        {b.canShare && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('knowledge.sharing')}
                            disabled={knowledgeLocked(b)}
                            onClick={() => setSharing(b)}
                          >
                            <Share2 />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('knowledge.edit')}
                          disabled={knowledgeLocked(b)}
                          onClick={() => setEditing(b)}
                        >
                          <Pencil />
                        </Button>
                        {b.canDelete && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('knowledge.delete')}
                            disabled={knowledgeLocked(b)}
                            onClick={() => setDeleting(b)}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : (
                    !b.enabled && (
                      <Badge variant="secondary" className="mt-2">
                        {t('knowledge.disabled')}
                      </Badge>
                    )
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </aside>
        {base ? (
          <KnowledgeDocuments key={base.id} base={base} />
        ) : (
          <div className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
            <BookOpen className="mb-4 size-10 text-muted-foreground/60" />
            <h2 className="font-medium">{t('knowledge.empty')}</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              {t('knowledge.emptyHint')}
            </p>
            {canManage && (
              <Button className="mt-5" onClick={() => setEditing('new')}>
                <Plus />
                {t('knowledge.create')}
              </Button>
            )}
          </div>
        )}
      </div>
      {editing && (
        <BaseDialog
          key={editing === 'new' ? 'new' : editing.id}
          scope={scope}
          base={
            editing === 'new'
              ? undefined
              : (bases.find((b) => b.id === editing.id) ?? editing)
          }
          onClose={() => setEditing(undefined)}
          onSaved={saved}
        />
      )}
      {sharing && (
        <SharingDialog
          base={bases.find((b) => b.id === sharing.id) ?? sharing}
          onClose={() => setSharing(undefined)}
          onSaved={(updated) => {
            if (scope.scope === 'shared' && updated.sharingMode === 'private') {
              setBases((current) => current.filter((b) => b.id !== updated.id));
              if (selected === updated.id) setSelected(undefined);
            } else saved(updated);
          }}
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
              <DialogTitle>{t('knowledge.delete')}</DialogTitle>
              <DialogDescription>
                {t('knowledge.deleteBaseHint', { name: deleting.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setDeleting(undefined)}
              >
                {t('knowledge.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={
                  busy ||
                  !!bases.find(
                    (b) => b.id === deleting.id && knowledgeLocked(b),
                  )
                }
                onClick={() => void remove()}
              >
                {t('knowledge.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
