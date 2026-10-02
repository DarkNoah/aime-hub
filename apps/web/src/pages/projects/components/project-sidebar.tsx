import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useMatch, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, ChevronRight, Folder, Plus } from 'lucide-react';
import type { ProjectSummary } from '@aime/shared/projects';
import type { ThreadSummary } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import {
  ThreadActivityTitle,
  RunningThreadCount,
} from '@/components/chat/thread-activity';
import { useProjectRunningCount } from '@/components/chat/thread-navigation-context';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { SidebarPageList } from '@/components/sidebar-page-list';
import { ThreadListItems } from '@/components/chat/thread-list-items';
import { ThreadDialog } from '@/components/chat/thread-dialogs';
import { useAuthSession } from '@/features/auth/session-context';
import { cn } from '@/lib/utils';
import { useProjectNavigation } from '../use-project-navigation';
import { ProjectSheet } from './project-sheet';

export function ProjectSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const activeProjectId = useMatch('/projects/:projectId/*')?.params.projectId;
  const { projects } = useProjectNavigation();
  const list = useSyncExternalStore(
    projects.subscribe,
    projects.getSnapshot,
    projects.getSnapshot,
  );
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  // Remember expansion between route changes. The current project opens on entry.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (id: string) => expanded[id] ?? id === activeProjectId;
  const anyExpanded = list.projects.some((project) => isExpanded(project.id));
  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            'flex h-10 items-center rounded-lg',
            location.pathname.startsWith('/projects') &&
              'bg-card text-primary ring-1 ring-border',
          )}
        >
          <CollapsibleTrigger className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg px-3 text-sm outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring">
            <Folder className="size-4 shrink-0" />
            <span className="font-medium">{t('nav.projects')}</span>
            <ChevronRight
              aria-hidden
              className={cn(
                'ml-auto size-3.5 text-muted-foreground transition-transform',
                open && 'rotate-90',
              )}
            />
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-1 shrink-0"
            aria-label={t('projects.create')}
            onClick={() => setCreating(true)}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        <CollapsibleContent forceMount hidden={!open}>
          <div className="mt-1 mb-2 ml-5 border-l pl-2">
            <Link
              to="/projects"
              onClick={onNavigate}
              className="mb-1 flex h-8 items-center justify-between rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('projects.all')}
              <ArrowUpRight className="size-3.5" />
            </Link>
            <SidebarPageList
              {...list}
              label={t('projects.list')}
              moreLabel={t('projects.loadMore')}
              loadMore={projects.loadMore}
              maxHeight={anyExpanded ? 'min(25rem,55dvh)' : '11.25rem'}
            >
              {!list.loading && !list.error && !list.projects.length && (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  {t('projects.empty')}
                </p>
              )}
              {list.projects.map((project) => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  open={isExpanded(project.id)}
                  onOpenChange={(value) =>
                    setExpanded((current) => ({
                      ...current,
                      [project.id]: value,
                    }))
                  }
                  onNavigate={onNavigate}
                />
              ))}
            </SidebarPageList>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {creating && (
        <ProjectSheet
          onClose={() => setCreating(false)}
          onSaved={(project) => {
            projects.update(project);
            setExpanded((current) => ({ ...current, [project.id]: true }));
            setOpen(true);
            navigate(`/projects/${project.id}`);
            onNavigate?.();
          }}
        />
      )}
    </>
  );
}

function ProjectItem({
  project,
  open,
  onOpenChange,
  onNavigate,
}: {
  project: ProjectSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useAuthSession();
  const match = useMatch('/projects/:projectId/threads/:threadId');
  const activeProjectId = useMatch('/projects/:projectId/*')?.params.projectId;
  const selectedId =
    match?.params.projectId === project.id ? match.params.threadId : undefined;
  const navigation = useProjectNavigation();
  const runningCount = useProjectRunningCount(project.id);
  const resource = navigation.threads(project.id);
  const list = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  const [action, setAction] = useState<{
    thread: ThreadSummary;
    mode: 'rename' | 'delete';
  } | null>(null);
  useEffect(() => {
    if (open && resource.getSnapshot().page < 0) void resource.loadMore();
  }, [open, resource]);
  const select = (id?: string) => {
    navigate(`/projects/${project.id}/threads${id ? `/${id}` : ''}`);
    onNavigate?.();
  };
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div
        className={cn(
          'group flex h-9 items-center rounded-md hover:bg-accent/60',
          activeProjectId === project.id && 'bg-accent/50 text-primary',
        )}
      >
        <CollapsibleTrigger
          title={project.name}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
          {runningCount > 0 && (
            <RunningThreadCount
              count={runningCount}
              className="shrink-0 px-1.5 py-0 text-[10px] tabular-nums"
            />
          )}
          <ThreadActivityTitle active={runningCount > 0}>
            {project.name}
          </ThreadActivityTitle>
        </CollapsibleTrigger>
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0"
          title={t('projects.openNamed', { name: project.name })}
        >
          <Link
            to={`/projects/${project.id}`}
            onClick={onNavigate}
            aria-label={t('projects.openNamed', { name: project.name })}
          >
            <ArrowUpRight className="size-3.5" />
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0"
          title={t('projects.newChatNamed', { name: project.name })}
          aria-label={t('projects.newChatNamed', { name: project.name })}
          onClick={() => select()}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <CollapsibleContent forceMount hidden={!open}>
        <div className="ml-3 border-l pl-1">
          <SidebarPageList
            {...list}
            label={t('projects.threadList', { name: project.name })}
            moreLabel={t('chat.moreThreads')}
            loadMore={resource.loadMore}
          >
            {!list.loading && !list.error && !list.threads.length && (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                {t('chat.emptyList')}
              </p>
            )}
            <ThreadListItems
              threads={list.threads}
              selectedId={selectedId}
              onSelect={select}
              onAction={(thread, mode) => setAction({ thread, mode })}
              canManage={(thread) =>
                project.role !== 'member' || thread.createdBy === data?.user.id
              }
            />
          </SidebarPageList>
        </div>
      </CollapsibleContent>
      {action && (
        <ThreadDialog
          {...action}
          onClose={() => setAction(null)}
          onSaved={resource.update}
          onDeleted={() => {
            resource.remove(action.thread.id);
            if (selectedId === action.thread.id) select();
          }}
        />
      )}
    </Collapsible>
  );
}
