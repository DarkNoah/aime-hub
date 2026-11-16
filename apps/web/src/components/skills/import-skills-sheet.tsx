import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  FileArchive,
  FolderGit2,
  Loader2,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import type { InstalledSkill, RepositorySkill } from '@aime/shared/skills';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { LoadingState } from '@/components/loading-state';
import {
  getSkillApi,
  skillErrorKey,
  type SkillScope,
  type SkillImportMode,
} from './api';
import {
  selectableSkills,
  selectionState,
  skillFolders,
  toggleSkills,
} from './selection';
import { useRepositoryScan } from './use-repository-scan';
import { useArchiveScan } from './use-archive-scan';
import { SkillArchiveInput } from './skill-archive-input';
import { SkillFolderContents } from './skill-folder';

export function ImportSkillsSheet({
  scope,
  onClose,
  onInstalled,
}: {
  scope: SkillScope;
  onClose: () => void;
  onInstalled: (skills: InstalledSkill[]) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'github' | 'archive'>('github');
  const [importMode, setImportMode] = useState<SkillImportMode>('skills');
  const repository = useRepositoryScan(scope, mode === 'github', importMode);
  const archive = useArchiveScan(scope);
  const archiveFile = useRef<File | undefined>(undefined);
  const source = mode === 'github' ? repository : archive;
  const client = getSkillApi(scope);
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<{
    id?: string;
    paths: Set<string>;
  }>({ paths: new Set() });
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const scan = source.scan;
  const selected =
    selection.id === scan?.id ? selection.paths : new Set<string>();
  const query = search.trim().toLocaleLowerCase();
  const visible =
    scan?.skills.filter((skill) =>
      `${skill.name} ${skill.path} ${skill.description}`
        .toLocaleLowerCase()
        .includes(query),
    ) ?? [];
  const tree = skillFolders(visible);
  function changeMode(value: string) {
    if (
      submitting.current ||
      value === mode ||
      (value !== 'github' && value !== 'archive')
    )
      return;
    archive.clearScan();
    archiveFile.current = undefined;
    repository.clearScan();
    repository.rescan();
    setSearch('');
    setMode(value);
  }
  function changeImportMode(value: string) {
    if (
      submitting.current ||
      value === importMode ||
      (value !== 'skills' && value !== 'project')
    )
      return;
    archive.clearScan();
    repository.clearScan();
    repository.rescan();
    setSearch('');
    setImportMode(value);
    if (mode === 'archive' && archiveFile.current)
      void upload(archiveFile.current, value);
  }
  async function upload(file: File, selectedMode = importMode) {
    if (submitting.current) return;
    archiveFile.current = file;
    setSearch('');
    const error = await archive.upload(file, selectedMode);
    if (error) toast.error(t(error));
  }
  function select(skills: RepositorySkill[], checked: boolean) {
    setSelection({
      id: scan?.id,
      paths: toggleSkills(selected, skills, checked),
    });
  }
  async function install() {
    if (!scan || !selected.size || submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      const installed = await client.install({
        body: { scanId: scan.id, paths: [...selected] },
      });
      onInstalled(installed);
      toast.success(
        t(
          importMode === 'project'
            ? 'skills.projectInstallSuccess'
            : 'skills.installSuccess',
          { count: installed.length },
        ),
      );
      onClose();
    } catch (error) {
      source.clearScan();
      toast.error(t(skillErrorKey(error)));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <SheetContent
        className="w-full gap-0 sm:max-w-3xl"
        showCloseButton={!pending}
      >
        <div className="space-y-2 border-b px-5 py-5 pr-14 sm:px-6">
          <SheetTitle className="flex items-center gap-2">
            <FolderGit2 className="size-5" />
            {t('skills.import')}
          </SheetTitle>
          <SheetDescription>{t('skills.importHint')}</SheetDescription>
        </div>
        <div className="space-y-3 border-b px-5 py-4 sm:px-6">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="skill-import-mode">
                {t('skills.importMode')}
              </Label>
              <Select
                value={importMode}
                onValueChange={changeImportMode}
                disabled={pending}
              >
                <SelectTrigger
                  id="skill-import-mode"
                  aria-label={t('skills.importMode')}
                  aria-describedby="skill-import-mode-hint"
                  className="w-44"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skills">
                    {t('skills.importBySkill')}
                  </SelectItem>
                  <SelectItem value="project">
                    {t('skills.importWholeProject')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p
              id="skill-import-mode-hint"
              className="text-xs leading-5 text-muted-foreground"
            >
              {t(
                importMode === 'project'
                  ? 'skills.projectImportHint'
                  : 'skills.bySkillImportHint',
              )}
            </p>
          </div>
          <Tabs value={mode} onValueChange={changeMode}>
            <TabsList className="w-full">
              <TabsTrigger value="github" disabled={pending}>
                <FolderGit2 />
                GitHub
              </TabsTrigger>
              <TabsTrigger value="archive" disabled={pending}>
                <FileArchive />
                {t('skills.archiveTab')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="github" className="pt-2">
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  repository.rescan();
                }}
              >
                <Label htmlFor="skill-source">{t('skills.source')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="skill-source"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    value={repository.input}
                    disabled={pending}
                    placeholder="owner/repo · https://github.com/owner/repo"
                    aria-describedby="skill-source-hint"
                    aria-invalid={!!repository.error}
                    onChange={(event) =>
                      repository.setInput(event.target.value)
                    }
                  />
                  <Button
                    variant="outline"
                    type="submit"
                    disabled={
                      pending || repository.loading || !repository.input.trim()
                    }
                  >
                    {repository.loading ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Search />
                    )}
                    <span className="hidden sm:inline">{t('skills.scan')}</span>
                    <span className="sr-only sm:hidden">
                      {t('skills.scan')}
                    </span>
                  </Button>
                </div>
                <p
                  id="skill-source-hint"
                  className="text-xs leading-5 text-muted-foreground"
                >
                  {t(
                    importMode === 'project'
                      ? 'skills.projectSourceHint'
                      : 'skills.sourceHint',
                  )}
                </p>
              </form>
            </TabsContent>
            <TabsContent value="archive" className="pt-2">
              <SkillArchiveInput
                filename={archive.filename}
                loading={archive.loading}
                disabled={pending}
                onFile={(file) => void upload(file)}
                onCancel={() => {
                  archiveFile.current = undefined;
                  archive.clearScan();
                }}
              />
            </TabsContent>
          </Tabs>
          {source.error ? (
            <p role="alert" className="text-sm text-destructive">
              {t(source.error)}
            </p>
          ) : null}
          {scan ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {scan.sourceType === 'archive' ? (
                <>
                  <span className="break-all font-medium text-foreground">
                    {scan.filename}
                  </span>
                  <Badge variant="outline">{t('skills.archiveTab')}</Badge>
                </>
              ) : (
                <>
                  <a
                    href={scan.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-foreground hover:underline"
                  >
                    {scan.owner}/{scan.repo}
                  </a>
                  <Badge variant="outline">
                    {scan.ref ?? t('skills.defaultBranch')} ·{' '}
                    {scan.commit.slice(0, 7)}
                  </Badge>
                  <span className="break-all">
                    {scan.scope || t('skills.repositoryRoot')}
                  </span>
                </>
              )}
            </div>
          ) : null}
        </div>
        {scan?.skills.length ? (
          <div className="space-y-3 border-b px-5 py-3 sm:px-6">
            <Input
              aria-label={t('skills.filter')}
              placeholder={t('skills.filter')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="flex items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={selectionState(visible, selected)}
                  disabled={pending || !selectableSkills(visible).length}
                  onCheckedChange={(checked) =>
                    select(visible, checked === true)
                  }
                />
                {t('skills.selectAll')}
              </label>
              <span className="text-xs text-muted-foreground" role="status">
                {t('skills.found', { count: scan.skills.length })}
              </span>
            </div>
          </div>
        ) : null}
        <ScrollArea
          className="min-h-0 flex-1"
          viewportProps={{ 'aria-busy': source.loading }}
        >
          <div className="px-3 py-4 sm:px-4">
            {scan?.project ? (
              <div className="mb-3 space-y-1.5 rounded-md bg-muted/50 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{t('skills.wholeProject')}</Badge>
                  <span>
                    {t('skills.projectFiles', {
                      count: scan.project.fileCount,
                    })}
                  </span>
                </div>
                <p className="break-all text-muted-foreground">
                  {t('skills.projectRoot', { path: scan.project.destination })}
                </p>
                <p className="text-muted-foreground">
                  {t('skills.projectEntryHint')}
                </p>
                {scan.project.skippedFiles > 0 ? (
                  <p className="text-muted-foreground">
                    {t('skills.skippedFiles', {
                      count: scan.project.skippedFiles,
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
            {source.loading ? (
              <LoadingState
                label={t(
                  mode === 'archive'
                    ? 'skills.archiveScanning'
                    : 'skills.scanning',
                )}
              />
            ) : scan ? (
              visible.length ? (
                <SkillFolderContents
                  folder={tree}
                  selected={selected}
                  disabled={pending}
                  onSelect={select}
                />
              ) : (
                <p className="px-3 py-12 text-center text-sm text-muted-foreground">
                  {t(
                    scan.skills.length ? 'skills.noMatches' : 'skills.noSkills',
                  )}
                </p>
              )
            ) : !source.error ? (
              <div className="space-y-3 px-4 py-12 text-center">
                {mode === 'archive' ? (
                  <FileArchive className="mx-auto size-7 text-muted-foreground" />
                ) : (
                  <FolderGit2 className="mx-auto size-7 text-muted-foreground" />
                )}
                <p className="text-sm font-medium">
                  {t(
                    mode === 'archive'
                      ? 'skills.startArchiveScan'
                      : 'skills.startScan',
                  )}
                </p>
                <p className="mx-auto max-w-sm text-xs leading-5 text-muted-foreground">
                  {t(
                    importMode === 'project'
                      ? 'skills.projectEntryHint'
                      : mode === 'archive'
                        ? 'skills.archiveStructureHint'
                        : 'skills.scanHint',
                  )}
                </p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-card px-5 py-4 sm:px-6">
          <span className="text-sm text-muted-foreground" role="status">
            {t(
              importMode === 'project'
                ? 'skills.projectEntriesSelected'
                : 'skills.selected',
              { count: selected.size },
            )}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" disabled={pending} onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button
              disabled={!scan || !selected.size || pending}
              onClick={() => void install()}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Download />}
              {t(
                pending
                  ? 'skills.installing'
                  : importMode === 'project'
                    ? 'skills.importProject'
                    : 'skills.install',
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
