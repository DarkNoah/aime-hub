import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FolderGit2, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { InstalledSkill, RepositorySkill } from '@aime/shared/skills';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { LoadingState } from '@/components/loading-state';
import { skillErrorKey, skillRequest } from '../api';
import {
  selectableSkills,
  selectionState,
  skillFolders,
  toggleSkills,
} from '../selection';
import { useRepositoryScan } from '../use-repository-scan';
import { SkillFolderContents } from './skill-folder';

export function ImportSkillsSheet({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: (skills: InstalledSkill[]) => void;
}) {
  const { t } = useTranslation();
  const source = useRepositoryScan();
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
      const installed = await skillRequest<InstalledSkill[]>('/install', {
        method: 'POST',
        body: JSON.stringify({ scanId: scan.id, paths: [...selected] }),
      });
      onInstalled(installed);
      source.markInstalled(installed.map((skill) => skill.path));
      setSelection({ id: scan.id, paths: new Set() });
      toast.success(t('skills.installSuccess', { count: installed.length }));
    } catch (error) {
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
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              source.rescan();
            }}
          >
            <Label htmlFor="skill-source">{t('skills.source')}</Label>
            <div className="flex gap-2">
              <Input
                id="skill-source"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={source.input}
                disabled={pending}
                placeholder="owner/repo · https://github.com/owner/repo"
                aria-describedby="skill-source-hint"
                aria-invalid={!!source.error}
                onChange={(event) => source.setInput(event.target.value)}
              />
              <Button
                variant="outline"
                type="submit"
                disabled={pending || source.loading || !source.input.trim()}
              >
                {source.loading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Search />
                )}
                <span className="hidden sm:inline">{t('skills.scan')}</span>
                <span className="sr-only sm:hidden">{t('skills.scan')}</span>
              </Button>
            </div>
            <p
              id="skill-source-hint"
              className="text-xs leading-5 text-muted-foreground"
            >
              {t('skills.sourceHint')}
            </p>
          </form>
          {source.error ? (
            <p role="alert" className="text-sm text-destructive">
              {t(source.error)}
            </p>
          ) : null}
          {scan ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
            {source.loading ? (
              <LoadingState label={t('skills.scanning')} />
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
                <FolderGit2 className="mx-auto size-7 text-muted-foreground" />
                <p className="text-sm font-medium">{t('skills.startScan')}</p>
                <p className="mx-auto max-w-sm text-xs leading-5 text-muted-foreground">
                  {t('skills.scanHint')}
                </p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-card px-5 py-4 sm:px-6">
          <span className="text-sm text-muted-foreground" role="status">
            {t('skills.selected', { count: selected.size })}
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
              {t(pending ? 'skills.installing' : 'skills.install')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
