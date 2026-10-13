import { useId } from 'react';
import {
  ChevronRight,
  Folder,
  ExternalLink,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  skillGroupRepositoryUrl,
  type InstalledSkill,
} from '@aime/shared/skills';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { selectableSkills, selectionState } from './selection';

type Props = {
  skills: InstalledSkill[];
  disabled?: boolean;
} & (
  | {
      mode: 'manage';
      onRemove: (skill: InstalledSkill) => void;
      onRemoveGroup: (group: string) => void;
      onUpdateGroup: (group: string) => void;
      onPreview: (skill: InstalledSkill) => void;
      updatingGroup?: string;
    }
  | {
      mode: 'select';
      search?: string;
      selected: ReadonlySet<string>;
      onSelect: (skill: InstalledSkill, checked: boolean) => void;
      onSelectGroup: (skills: InstalledSkill[], checked: boolean) => void;
    }
);

/** Shared installed-skill presentation for administration and agent assignment. */
export function InstalledSkillsList(props: Props) {
  const { t } = useTranslation();
  const id = useId();
  const query =
    props.mode === 'select' ? props.search?.trim().toLowerCase() : '';
  const groups = new Map<string, InstalledSkill[]>();
  for (const skill of props.skills) {
    const group = groups.get(skill.group) ?? [];
    group.push(skill);
    groups.set(skill.group, group);
  }
  return [...groups].map(([group, skills]) => {
    const visibleSkills = query
      ? skills.filter((skill) =>
          `${skill.name} ${skill.path} ${skill.description}`
            .toLowerCase()
            .includes(query),
        )
      : skills;
    if (!visibleSkills.length) return null;
    const repositoryUrl = skillGroupRepositoryUrl(group);
    const label = group || t('skills.localGroup');
    const heading = (
      <>
        <Folder
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 break-all">{label}</span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {skills.length}
        </span>
      </>
    );
    return (
      <Collapsible key={group} defaultOpen asChild>
        <section aria-label={label}>
          <div className="flex items-center border-b bg-muted/50">
            {props.mode === 'select' ? (
              <Checkbox
                className="ml-4 sm:ml-5"
                aria-label={t('skills.selectGroup', { name: label })}
                checked={selectionState(skills, props.selected)}
                disabled={props.disabled || !selectableSkills(skills).length}
                onCheckedChange={(checked) =>
                  props.onSelectGroup(skills, checked === true)
                }
              />
            ) : null}
            <h2 className="min-w-0 flex-1 text-sm font-medium">
              {group ? (
                <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5 [&[data-state=open]>svg:first-child]:rotate-90">
                  <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground transition-transform"
                    aria-hidden="true"
                  />
                  {heading}
                </CollapsibleTrigger>
              ) : (
                <div className="flex items-center gap-2 px-4 py-3 sm:px-5">
                  {heading}
                </div>
              )}
            </h2>
            {group && props.mode === 'manage' ? (
              <div className="mr-2 flex shrink-0 items-center gap-0.5">
                {repositoryUrl ? (
                  <>
                    <Button variant="ghost" size="icon" asChild>
                      <a
                        href={repositoryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t('skills.openRepository', { name: group })}
                        title={t('skills.openRepository', { name: group })}
                      >
                        <ExternalLink className="text-muted-foreground" />
                      </a>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={props.disabled}
                      onClick={() => props.onUpdateGroup(group)}
                      aria-label={t('skills.updateGroupNamed', { name: group })}
                      title={t('skills.updateGroupNamed', { name: group })}
                    >
                      <RefreshCw
                        className={
                          props.updatingGroup === group
                            ? 'animate-spin text-primary'
                            : 'text-muted-foreground'
                        }
                      />
                    </Button>
                  </>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={props.disabled}
                  aria-label={t('skills.removeGroupNamed', { name: group })}
                  title={t('skills.removeGroupNamed', { name: group })}
                  onClick={() => props.onRemoveGroup(group)}
                >
                  <Trash2 className="text-muted-foreground" />
                </Button>
              </div>
            ) : null}
          </div>
          <CollapsibleContent>
            <div className="divide-y">
              {visibleSkills.map((skill) => (
                <article
                  key={skill.path}
                  className="relative flex items-start gap-3 px-4 py-4 sm:px-5"
                >
                  {props.mode === 'select' ? (
                    <Checkbox
                      id={`${id}-${skill.path}`}
                      className="mt-1"
                      aria-label={t('skills.selectSkill', { name: skill.name })}
                      checked={props.selected.has(skill.path)}
                      disabled={props.disabled || !skill.valid}
                      onCheckedChange={(checked) =>
                        props.onSelect(skill, checked === true)
                      }
                    />
                  ) : (
                    <Sparkles
                      className="mt-1 size-4 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-all text-sm font-medium">
                        {props.mode === 'select' ? (
                          <label
                            className="cursor-pointer"
                            htmlFor={`${id}-${skill.path}`}
                          >
                            {skill.name}
                          </label>
                        ) : (
                          <button
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onPreview(skill)}
                            aria-label={t('skills.previewNamed', {
                              name: skill.name,
                            })}
                            className="text-left outline-none after:absolute after:inset-0 after:transition-colors hover:text-primary hover:after:bg-muted/20 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                          >
                            {skill.name}
                          </button>
                        )}
                      </h3>
                      <Badge
                        variant={skill.valid ? 'secondary' : 'destructive'}
                      >
                        {t(skill.valid ? 'skills.installed' : 'skills.invalid')}
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
                  {props.mode === 'manage' ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative z-10"
                      disabled={!skill.path || props.disabled}
                      aria-label={t('skills.removeNamed', { name: skill.name })}
                      onClick={() => props.onRemove(skill)}
                    >
                      <Trash2 className="text-muted-foreground" />
                    </Button>
                  ) : null}
                </article>
              ))}
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>
    );
  });
}
