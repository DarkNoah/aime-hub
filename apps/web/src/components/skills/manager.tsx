import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, apiErrorCode } from '@/lib/rpc';
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
import type {
  InstalledSkill,
  InstalledSkills,
  SkillDestination,
  SkillSharing,
  SkillSharingOptions,
} from '@aime/shared/skills';
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
import { ShareSkillDialog } from './share-skill-dialog';

const SkillPreviewDialog = lazy(() =>
  import('./skill-preview-dialog').then((m) => ({
    default: m.SkillPreviewDialog,
  })),
);

type SkillRemoval =
  | { kind: 'skill'; skill: InstalledSkill }
  | { kind: 'group'; group: string; skills: InstalledSkill[] };

function sameDestination(
  sharing: SkillSharing | undefined,
  target: SkillDestination,
) {
  return target.scope === 'global'
    ? sharing?.scope === 'global'
    : sharing?.scope === 'project' && sharing.projectId === target.projectId;
}

export function SkillsManager({ scope }: { scope: SkillScope }) {
  const { t } = useTranslation();
  const client = getSkillApi(scope);
  const [catalog, setCatalog] = useState<InstalledSkills>();
  const [sharing, setSharing] = useState<SkillSharingOptions>();
  const [sharingError, setSharingError] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<InstalledSkill>();
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
  const removingProject =
    removing?.kind === 'group' &&
    removing.skills.some((skill) => skill.projectRoot);
  const submitting = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.allSettled([
      client.list(undefined, options),
      scope === 'personal'
        ? api.personalSkills.sharing(undefined, options)
        : undefined,
    ]).then(([catalogResult, sharingResult]) => {
      if (controller.signal.aborted) return;
      if (catalogResult.status === 'fulfilled') {
        setCatalog(catalogResult.value);
        setError(undefined);
      } else {
        setError(skillErrorKey(catalogResult.reason));
      }
      setSharingError(sharingResult.status === 'rejected');
      if (sharingResult.status === 'fulfilled') setSharing(sharingResult.value);
      setLoading(false);
    });
    return () => controller.abort();
  }, [client, scope, revision]);
  const query = search.trim().toLocaleLowerCase();
  const personalPaths = new Set(catalog?.skills.map((item) => item.path));
  const publishedByPath = new Map<string, SkillSharing[]>();
  const otherEntries = (sharing?.shared ?? []).filter((item) => {
    if (
      !item.sharing ||
      item.sharing.legacyMoved ||
      !personalPaths.has(item.path)
    )
      return true;
    const locations = publishedByPath.get(item.path) ?? [];
    locations.push(item.sharing);
    publishedByPath.set(item.path, locations);
    return false;
  });
  const skills = [...(catalog?.skills ?? []), ...otherEntries];
  const linkedGroups = new Set<string>();
  for (const item of catalog?.skills ?? []) {
    if (!item.sharing || item.sharing.legacyMoved) continue;
    const parts = item.group.split('/');
    while (parts.length) {
      linkedGroups.add(parts.join('/'));
      parts.pop();
    }
  }
  const visible = skills.filter((skill) =>
    `${skill.name} ${skill.path} ${skill.description} ${skill.sharing?.userName ?? ''} ${skill.sharing?.projectName ?? ''}`
      .toLocaleLowerCase()
      .includes(query),
  );
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
  function canShare(skill: InstalledSkill) {
    if (scope !== 'personal' || !sharing || sharingError || !skill.path)
      return false;
    return (
      !!skill.sharing ||
      publishedByPath.has(skill.path) ||
      sharing.global ||
      sharing.projects.length > 0
    );
  }
  async function changeSharing(
    skill: InstalledSkill,
    target: Parameters<
      typeof api.personalSkills.setSharing
    >[0]['body']['target'],
  ) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      const affected = await api.personalSkills.setSharing({
        body: { path: skill.path, target },
      });
      const affectedPaths = new Set(affected.map((item) => item.path));
      const destination = target.scope === 'personal' ? target.from : target;
      setSharing((current) => {
        if (!current) return current;
        const retained = current.shared.filter(
          (item) =>
            !affectedPaths.has(item.path) ||
            !sameDestination(item.sharing, destination),
        );
        return {
          ...current,
          shared:
            target.scope === 'personal' ? retained : [...retained, ...affected],
        };
      });
      if (target.scope === 'personal' && skill.sharing?.legacyMoved)
        installed(affected);
      setSelectedSkill(undefined);
      toast.success(
        t(
          target.scope === 'personal'
            ? skill.sharing?.legacyMoved
              ? 'skills.moveBackSuccess'
              : 'skills.unshareSuccess'
            : 'skills.shareSuccess',
        ),
      );
    } catch (cause) {
      if (
        apiErrorCode(cause) === 'PROJECT_ARCHIVED' &&
        target.scope === 'project'
      ) {
        setSharing(
          (current) =>
            current && {
              ...current,
              projects: current.projects.filter(
                (project) => project.id !== target.projectId,
              ),
            },
        );
        setSelectedSkill(undefined);
      }
      toast.error(
        t(
          apiErrorCode(cause) === 'SKILL_CONFLICT'
            ? 'skills.shareConflict'
            : skillErrorKey(cause),
        ),
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  function unshare(skill: InstalledSkill, location: SkillDestination) {
    const from: SkillDestination =
      location.scope === 'global'
        ? { scope: 'global' }
        : { scope: 'project', projectId: location.projectId };
    void changeSharing(skill, { scope: 'personal', from });
  }
  function chooseShare(skill: InstalledSkill) {
    if (!skill.sharing) {
      setSelectedSkill(skill);
    } else {
      unshare(skill, skill.sharing);
    }
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
      setSharing(
        (current) =>
          current && {
            ...current,
            shared: current.shared.filter(
              (item) =>
                item.sharing?.legacyMoved || !removedPaths.has(item.path),
            ),
          },
      );
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
          ? t(
              removingProject
                ? 'skills.removeProjectSuccess'
                : 'skills.removeGroupSuccess',
              { count: removed.length },
            )
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
              ...current.skills.filter((skill) => skill.group !== group),
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
          {t('skills.installedCount', { count: skills.length })}
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
      {error || sharingError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/25 p-4 text-sm text-destructive"
        >
          <span>{t(error ?? 'skills.sharingLoadError')}</span>
          <Button variant="outline" onClick={refresh}>
            {t('skills.retry')}
          </Button>
        </div>
      ) : null}
      {loading && !catalog ? (
        <LoadingState />
      ) : skills.length ? (
        <ScrollArea
          className="h-[min(65dvh,48rem)] rounded-xl border bg-card"
          viewportProps={{ 'aria-busy': loading }}
        >
          {visible.length ? (
            <InstalledSkillsList
              mode="manage"
              skills={visible}
              disabled={loading || pending}
              personal={scope === 'personal'}
              publishedByPath={publishedByPath}
              linkedGroups={linkedGroups}
              canShare={canShare}
              onShare={chooseShare}
              updatingGroup={updatingGroup}
              onUpdateGroup={(group) => void updateGroup(group)}
              onPreview={setPreview}
              onRemove={(skill) => setRemoving({ kind: 'skill', skill })}
              onRemoveGroup={(group) =>
                setRemoving({
                  kind: 'group',
                  group,
                  skills: (catalog?.skills ?? []).filter(
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
      {selectedSkill && sharing ? (
        <ShareSkillDialog
          skill={selectedSkill}
          sharing={sharing}
          pending={pending}
          onClose={() => setSelectedSkill(undefined)}
          published={publishedByPath.get(selectedSkill.path) ?? []}
          onShare={(target) => void changeSharing(selectedSkill, target)}
          onUnshare={(target) => unshare(selectedSkill, target)}
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
            root={catalog?.root ?? ''}
            onUpdated={(skill) => {
              setCatalog((current) =>
                current
                  ? {
                      ...current,
                      skills: current.skills.map((item) =>
                        item.path === skill.path ? skill : item,
                      ),
                    }
                  : current,
              );
            }}
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
                  ? removingProject
                    ? 'skills.removeProjectTitle'
                    : 'skills.removeGroupTitle'
                  : 'skills.removeTitle',
              )}
            </DialogTitle>
            <DialogDescription>
              {removing?.kind === 'group'
                ? t(
                    removingProject
                      ? 'skills.removeProjectHint'
                      : 'skills.removeGroupHint',
                    {
                      name: removing.group,
                      count: removing.skills.length,
                    },
                  )
                : t(
                    scope === 'personal'
                      ? 'skills.personalRemoveHint'
                      : 'skills.removeHint',
                    { name: removing?.skill.name ?? '' },
                  )}
            </DialogDescription>
            {removing &&
              scope === 'personal' &&
              (removing.kind === 'skill'
                ? [removing.skill]
                : removing.skills
              ).some((item) => publishedByPath.has(item.path)) && (
                <p className="text-sm text-muted-foreground">
                  {t('skills.removePublishedHint')}
                </p>
              )}
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
                  ? removingProject
                    ? 'skills.removeProject'
                    : 'skills.removeGroup'
                  : 'skills.remove',
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
