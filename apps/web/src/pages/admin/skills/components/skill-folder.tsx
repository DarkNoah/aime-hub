import { ChevronRight, FileText, Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RepositorySkill } from '@aime/shared/skills';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  selectableSkills,
  selectionState,
  type SkillFolder,
} from '../selection';

type SelectionProps = {
  selected: Set<string>;
  disabled: boolean;
  onSelect: (skills: RepositorySkill[], checked: boolean) => void;
};

function SkillRow({
  skill,
  selected,
  disabled,
  onSelect,
}: SelectionProps & { skill: RepositorySkill }) {
  const { t } = useTranslation();
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/50 has-[[data-state=checked]]:bg-secondary/50">
      <Checkbox
        className="mt-1"
        aria-label={t('skills.selectSkill', { name: skill.name })}
        checked={selected.has(skill.path)}
        disabled={disabled || skill.installed || !skill.valid}
        onCheckedChange={(checked) => onSelect([skill], checked === true)}
      />
      <FileText
        className="mt-1 size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium break-all">{skill.name}</span>
          {skill.installed ? (
            <Badge variant="secondary">{t('skills.installed')}</Badge>
          ) : null}
          {!skill.valid ? (
            <Badge variant="destructive">{t('skills.invalid')}</Badge>
          ) : null}
        </span>
        <span className="block break-all font-mono text-xs text-muted-foreground">
          {skill.path}
        </span>
        {skill.description ? (
          <span
            className="line-clamp-2 text-xs leading-5 text-muted-foreground"
            title={skill.description}
          >
            {skill.description}
          </span>
        ) : null}
        <span className="block text-xs text-muted-foreground">
          {t('skills.files', { count: skill.fileCount })}
        </span>
        <span className="block break-all text-xs text-muted-foreground">
          {t('skills.destination', { path: skill.destination })}
        </span>
        {skill.skippedFiles > 0 ? (
          <span className="block text-xs text-muted-foreground">
            {t('skills.skippedFiles', { count: skill.skippedFiles })}
          </span>
        ) : null}
        {!skill.valid ? (
          <span className="block text-xs text-destructive">
            {skill.errors.join(' ')}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function SkillFolderContents({
  folder,
  ...props
}: SelectionProps & { folder: SkillFolder }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      {folder.skills.map((skill) => (
        <SkillRow key={skill.path} skill={skill} {...props} />
      ))}
      {folder.folders.map((child) => (
        <Collapsible key={child.path} defaultOpen className="group/folder">
          <div className="flex items-center gap-3 rounded-lg bg-muted/45 px-3 py-2">
            <Checkbox
              aria-label={t('skills.selectFolder', { name: child.path })}
              checked={selectionState(child.descendants, props.selected)}
              disabled={
                props.disabled || !selectableSkills(child.descendants).length
              }
              onCheckedChange={(checked) =>
                props.onSelect(child.descendants, checked === true)
              }
            />
            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring [&[data-state=open]>svg:first-child]:rotate-90">
              <ChevronRight
                className="size-3.5 shrink-0 transition-transform"
                aria-hidden="true"
              />
              <Folder
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {child.label}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {child.descendants.length}
              </span>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="ml-3 border-l pl-2 sm:ml-5 sm:pl-3">
            <SkillFolderContents folder={child} {...props} />
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}
