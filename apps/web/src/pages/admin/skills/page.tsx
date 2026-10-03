import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Folder,
  FolderGit2,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { InstalledSkill, InstalledSkills } from '@aime/shared/skills';
import type { TranslationKey } from '@/i18n/config';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { skillErrorKey, skillRequest } from './api';
import { ImportSkillsSheet } from './components/import-skills-sheet';

export function AdminSkillsPage() {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<InstalledSkills>();
  const [error, setError] = useState<TranslationKey>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<InstalledSkill>();
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void skillRequest<InstalledSkills>('', { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) {
          setCatalog(data);
          setError(undefined);
          setLoading(false);
        }
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(skillErrorKey(cause));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [revision]);
  const query = search.trim().toLocaleLowerCase();
  const visible =
    catalog?.skills.filter((skill) =>
      `${skill.name} ${skill.path} ${skill.description}`
        .toLocaleLowerCase()
        .includes(query),
    ) ?? [];
  const groups = new Map<string, InstalledSkill[]>();
  for (const skill of visible)
    groups.set(skill.group, [...(groups.get(skill.group) ?? []), skill]);
  function refresh() {
    setLoading(true);
    setRevision((value) => value + 1);
  }
  function installed(skills: InstalledSkill[]) {
    setCatalog((current) =>
      current
        ? {
            ...current,
            skills: [
              ...new Map(
                [...current.skills, ...skills].map((skill) => [
                  skill.path,
                  skill,
                ]),
              ).values(),
            ].sort((a, b) => a.path.localeCompare(b.path)),
          }
        : current,
    );
  }
  async function remove() {
    if (!removing || submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      await skillRequest('', {
        method: 'DELETE',
        body: JSON.stringify({ path: removing.path }),
      });
      setCatalog((current) =>
        current
          ? {
              ...current,
              skills: current.skills.filter(
                (skill) => skill.path !== removing.path,
              ),
            }
          : current,
      );
      setRemoving(undefined);
      toast.success(t('skills.removeSuccess'));
    } catch (cause) {
      toast.error(t(skillErrorKey(cause)));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title={t('nav.skills')}
        description={t('admin.skillsDescription')}
        actions={
          <Button
            disabled={loading || !!error}
            onClick={() => setImporting(true)}
          >
            <FolderGit2 />
            {t('skills.import')}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="pl-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label={t('skills.filter')}
            placeholder={t('skills.filter')}
          />
        </div>
        <Badge variant="secondary">
          {t('skills.installedCount', { count: catalog?.skills.length ?? 0 })}
        </Badge>
        <Button
          variant="outline"
          size="icon"
          className="ml-auto"
          disabled={loading}
          onClick={refresh}
          aria-label={t('skills.refresh')}
        >
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
        </Button>
      </div>
      {catalog ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{t('skills.storage')}</p>
          <code className="block break-all">{catalog.root}</code>
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/25 p-4 text-sm text-destructive"
        >
          <span>{t(error)}</span>
          <Button variant="outline" onClick={refresh}>
            {t('skills.retry')}
          </Button>
        </div>
      ) : null}
      {loading && !catalog ? (
        <LoadingState />
      ) : catalog?.skills.length ? (
        <ScrollArea
          className="h-[min(65dvh,48rem)] rounded-xl border bg-card"
          viewportProps={{ 'aria-busy': loading }}
        >
          {visible.length ? (
            [...groups].map(([group, skills]) => (
              <section key={group} aria-label={group || t('skills.localGroup')}>
                <h2 className="flex items-center gap-2 border-b bg-muted/50 px-4 py-3 text-sm font-medium sm:px-5">
                  <Folder
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 break-all">
                    {group || t('skills.localGroup')}
                  </span>
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    {skills.length}
                  </span>
                </h2>
                <div className="divide-y">
                  {skills.map((skill) => (
                    <article
                      key={skill.path}
                      className="flex items-start gap-3 px-4 py-4 sm:px-5"
                    >
                      <Sparkles
                        className="mt-1 size-4 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="break-all text-sm font-medium">
                            {skill.name}
                          </h3>
                          <Badge
                            variant={skill.valid ? 'secondary' : 'destructive'}
                          >
                            {t(
                              skill.valid
                                ? 'skills.installed'
                                : 'skills.invalid',
                            )}
                          </Badge>
                        </div>
                        {skill.description ? (
                          <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
                            {skill.description}
                          </p>
                        ) : null}
                        <p className="break-all font-mono text-xs text-muted-foreground">
                          {skill.path ? `${skill.path}/` : ''}SKILL.md
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={!skill.path || loading}
                        aria-label={t('skills.removeNamed', {
                          name: skill.name,
                        })}
                        onClick={() => setRemoving(skill)}
                      >
                        <Trash2 className="text-muted-foreground" />
                      </Button>
                    </article>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <p className="px-5 py-16 text-center text-sm text-muted-foreground">
              {t('skills.noMatches')}
            </p>
          )}
        </ScrollArea>
      ) : !error && !loading ? (
        <div className="rounded-xl border border-dashed px-6 py-16 text-center">
          <Sparkles className="mx-auto mb-4 size-7 text-muted-foreground" />
          <h2 className="text-base font-medium">{t('skills.empty')}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            {t('skills.emptyHint')}
          </p>
          <Button
            variant="outline"
            className="mt-5"
            onClick={() => setImporting(true)}
          >
            <FolderGit2 />
            {t('skills.import')}
          </Button>
        </div>
      ) : null}
      {importing ? (
        <ImportSkillsSheet
          onClose={() => setImporting(false)}
          onInstalled={installed}
        />
      ) : null}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !submitting.current) setRemoving(undefined);
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>{t('skills.removeTitle')}</DialogTitle>
            <DialogDescription>
              {t('skills.removeHint', { name: removing?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <code className="break-all text-xs text-muted-foreground">
            {removing?.path}
          </code>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setRemoving(undefined)}
            >
              {t('skills.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void remove()}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t('skills.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
