import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { apiErrorCode } from '@/lib/rpc';
import { useTranslation } from 'react-i18next';
import {
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
import { InstalledSkillsList } from '@/components/skills/installed-skills-list';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getSkillApi, skillErrorKey, type SkillScope } from './api';
import { ImportSkillsSheet } from './import-skills-sheet';
import { UpdateSourceDialog } from './update-source-dialog';

const SkillPreviewDialog = lazy(() =>
  import('./skill-preview-dialog').then((m) => ({
    default: m.SkillPreviewDialog,
  })),
);

type SkillRemoval =
  | { kind: 'skill'; skill: InstalledSkill }
  | { kind: 'group'; group: string; skills: InstalledSkill[] };

export function SkillsManager({ scope }: { scope: SkillScope }) {
  const { t } = useTranslation();
  const client = getSkillApi(scope);
  const [catalog, setCatalog] = useState<InstalledSkills>();
  const [error, setError] = useState<TranslationKey>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<SkillRemoval>();
  const [pending, setPending] = useState(false);
  const [updatingGroup, setUpdatingGroup] = useState<string>();
  const [sourceGroup, setSourceGroup] = useState<string>();
  const [preview, setPreview] = useState<InstalledSkill>();
  const submitting = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void client.list(undefined, { signal: controller.signal }).then(
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
  }, [client, revision]);
  const query = search.trim().toLocaleLowerCase();
  const visible =
    catalog?.skills.filter((skill) =>
      `${skill.name} ${skill.path} ${skill.description}`
        .toLocaleLowerCase()
        .includes(query),
    ) ?? [];
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
      let removed: string[];
      if (removing.kind === 'group') {
        removed = await client.removeGroup({
          body: {
            group: removing.group,
            paths: removing.skills.map((skill) => skill.path),
          },
        });
      } else {
        await client.remove({ body: { path: removing.skill.path } });
        removed = [removing.skill.path];
      }
      const removedPaths = new Set(removed);
      setCatalog((current) =>
        current
          ? {
              ...current,
              skills: current.skills.filter(
                (skill) => !removedPaths.has(skill.path),
              ),
            }
          : current,
      );
      setRemoving(undefined);
      toast.success(
        removing.kind === 'group'
          ? t('skills.removeGroupSuccess', { count: removed.length })
          : t('skills.removeSuccess'),
      );
    } catch (cause) {
      toast.error(t(skillErrorKey(cause)));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  function updated(group: string, skills: InstalledSkill[]) {
    setCatalog((current) =>
      current
        ? {
            ...current,
            skills: [
              ...current.skills.filter(
                (skill) => !skill.path.startsWith(`${group}/`),
              ),
              ...skills,
            ].sort((a, b) => a.path.localeCompare(b.path)),
          }
        : current,
    );
    toast.success(
      t('skills.updateGroupSuccess', { name: group, count: skills.length }),
    );
  }
  async function updateGroup(group: string) {
    if (submitting.current) return;
    submitting.current = true;
    setUpdatingGroup(group);
    setPending(true);
    try {
      updated(group, await client.updateGroup({ body: { group } }));
    } catch (cause) {
      if (apiErrorCode(cause) === 'SKILL_SOURCE_UNKNOWN') setSourceGroup(group);
      else toast.error(t(skillErrorKey(cause)));
    } finally {
      submitting.current = false;
      setUpdatingGroup(undefined);
      setPending(false);
    }
  }
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title={t('nav.skills')}
        description={t(
          scope === 'personal'
            ? 'skills.personalDescription'
            : 'admin.skillsDescription',
        )}
        actions={
          <Button
            disabled={loading || !!error || pending}
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
          disabled={loading || pending}
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
            <InstalledSkillsList
              mode="manage"
              skills={visible}
              disabled={loading || pending}
              updatingGroup={updatingGroup}
              onUpdateGroup={(group) => void updateGroup(group)}
              onPreview={setPreview}
              onRemove={(skill) => setRemoving({ kind: 'skill', skill })}
              onRemoveGroup={(group) =>
                setRemoving({
                  kind: 'group',
                  group,
                  skills: catalog.skills.filter(
                    (skill) => skill.group === group,
                  ),
                })
              }
            />
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
          scope={scope}
          onClose={() => setImporting(false)}
          onInstalled={installed}
        />
      ) : null}
      {sourceGroup ? (
        <UpdateSourceDialog
          scope={scope}
          group={sourceGroup}
          onClose={() => setSourceGroup(undefined)}
          onUpdated={(skills) => updated(sourceGroup, skills)}
        />
      ) : null}
      {preview ? (
        <Suspense fallback={null}>
          <SkillPreviewDialog
            key={`${scope}:${preview.path}`}
            scope={scope}
            skill={preview}
            onClose={() => setPreview(undefined)}
          />
        </Suspense>
      ) : null}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !submitting.current) setRemoving(undefined);
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>
              {t(
                removing?.kind === 'group'
                  ? 'skills.removeGroupTitle'
                  : 'skills.removeTitle',
              )}
            </DialogTitle>
            <DialogDescription>
              {removing?.kind === 'group'
                ? t('skills.removeGroupHint', {
                    name: removing.group,
                    count: removing.skills.length,
                  })
                : t(
                    scope === 'personal'
                      ? 'skills.personalRemoveHint'
                      : 'skills.removeHint',
                    { name: removing?.skill.name ?? '' },
                  )}
            </DialogDescription>
          </DialogHeader>
          <code className="break-all text-xs text-muted-foreground">
            {removing?.kind === 'group' ? removing.group : removing?.skill.path}
          </code>
          {removing?.kind === 'group' ? (
            <ScrollArea className="h-40 rounded-md border">
              <ul className="space-y-2 p-3 text-sm">
                {removing.skills.map((skill) => (
                  <li key={skill.path} className="break-all">
                    {skill.name}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          ) : null}
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
              {t(
                removing?.kind === 'group'
                  ? 'skills.removeGroup'
                  : 'skills.remove',
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
