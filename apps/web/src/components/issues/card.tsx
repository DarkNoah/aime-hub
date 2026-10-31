import { useTranslation } from 'react-i18next';
import { ArrowUpRight, MoreHorizontal } from 'lucide-react';
import type { Issue } from '@aime/shared/issues';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { IssueThreadLink } from './presentation';

export function IssueCard({
  issue,
  active,
  showDescription,
  showUpdatedAt,
  onDetails,
}: {
  issue: Issue;
  active: boolean;
  showDescription: boolean;
  showUpdatedAt: boolean;
  onDetails: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <li
      className={cn(
        'group relative rounded-lg border border-border/70 bg-card transition-colors hover:border-foreground/25',
        active && 'border-primary/50 bg-primary/5',
      )}
    >
      <IssueThreadLink
        issue={issue}
        className="block space-y-1.5 rounded-lg p-3"
      >
        <span className="block pr-7 font-mono text-[11px] text-muted-foreground">
          #{issue.id}
        </span>
        <h3 className="line-clamp-2 break-words text-sm leading-5 font-medium">
          {issue.title}
        </h3>
        {showDescription && issue.body.trim() && (
          <p className="line-clamp-1 break-words text-xs leading-5 text-muted-foreground">
            {issue.body.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\s+/g, ' ')}
          </p>
        )}
        {showUpdatedAt && (
          <div className="flex items-center justify-between gap-2 pt-1 text-[11px] text-muted-foreground">
            <time dateTime={issue.updatedAt}>
              {new Date(issue.updatedAt).toLocaleDateString(i18n.language, {
                month: 'short',
                day: 'numeric',
              })}
            </time>
            <ArrowUpRight className="size-3.5" aria-hidden />
          </div>
        )}
      </IssueThreadLink>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-1.5 right-1.5 text-muted-foreground"
        aria-label={t('issues.detailsFor', { title: issue.title })}
        onClick={onDetails}
      >
        <MoreHorizontal className="size-4" />
      </Button>
    </li>
  );
}
