import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { Issue, IssueState } from '@aime/shared/issues';
import { Badge } from '@/components/ui/badge';
import { issueWorkspaceState } from '@/components/chat/workspace-navigation';
import { cn } from '@/lib/utils';

const colors: Record<IssueState, string> = {
  decision:
    'border-amber-300/60 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200',
  todo: 'bg-muted text-muted-foreground',
  in_progress:
    'border-blue-300/60 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-200',
  done: 'border-emerald-300/60 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200',
};
export function IssueStateBadge({ state }: { state: IssueState }) {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className={colors[state]}>
      {t(`issues.state.${state}`)}
    </Badge>
  );
}
export function IssueThreadLink({
  issue,
  children,
  className,
  onClick,
}: {
  issue: Pick<Issue, 'threadId' | 'projectId'>;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const props = {
    className: cn(
      'rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
      className,
    ),
    state: issueWorkspaceState(issue.threadId),
    children,
    onClick,
  };
  return issue.projectId ? (
    <Link
      {...props}
      to="/projects/$projectId/threads/$threadId"
      params={{ projectId: issue.projectId, threadId: issue.threadId }}
    />
  ) : (
    <Link
      {...props}
      to="/threads/$threadId"
      params={{ threadId: issue.threadId }}
    />
  );
}
