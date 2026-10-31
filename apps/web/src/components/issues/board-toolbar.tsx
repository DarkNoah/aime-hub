import { useTranslation } from 'react-i18next';
import { Columns3, ListFilter, Plus, SlidersHorizontal, X } from 'lucide-react';
import { issueStates, type IssueState } from '@aime/shared/issues';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function IssueBoardToolbar({
  projectId,
  states,
  onStatesChange,
  showDescription,
  onDescriptionChange,
  showUpdatedAt,
  onUpdatedAtChange,
  count,
  loading,
  onCreate,
  onClose,
}: {
  projectId?: string;
  states: IssueState[];
  onStatesChange: (states: IssueState[]) => void;
  showDescription: boolean;
  onDescriptionChange: (show: boolean) => void;
  showUpdatedAt: boolean;
  onUpdatedAtChange: (show: boolean) => void;
  count: number;
  loading: boolean;
  onCreate: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <h2 className="sr-only">{t('issues.heading')}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className="h-8 gap-1.5 rounded-md bg-card px-2.5 text-xs font-medium"
        >
          <Columns3 className="size-3.5" aria-hidden />
          {t('issues.board')}
        </Badge>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <ListFilter />
              {t('issues.filter')}
              {states.length !== issueStates.length && (
                <span className="text-xs tabular-nums">{states.length}</span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('issues.status')}</DropdownMenuLabel>
            {issueStates.map((state) => (
              <DropdownMenuCheckboxItem
                key={state}
                checked={states.includes(state)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  onStatesChange(
                    checked
                      ? [...states, state]
                      : states.filter((item) => item !== state),
                  )
                }
              >
                {t(`issues.state.${state}`)}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onStatesChange([...issueStates])}>
              {t('issues.resetFilters')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <SlidersHorizontal />
              {t('issues.display')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('issues.cardFields')}</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={showDescription}
              onCheckedChange={onDescriptionChange}
              onSelect={(event) => event.preventDefault()}
            >
              {t('issues.showDescription')}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={showUpdatedAt}
              onCheckedChange={onUpdatedAtChange}
              onSelect={(event) => event.preventDefault()}
            >
              {t('issues.showUpdatedAt')}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {t(projectId ? 'issues.project' : 'issues.personal')} ·{' '}
            {loading ? '…' : t('issues.count', { count })}
          </span>
          <Button size="sm" onClick={onCreate}>
            <Plus />
            {t('issues.create')}
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={t('nav.close')}
            >
              <X />
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
