import { isThreadActive } from '@aime/shared/threads';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Clock3,
  BookOpen,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Settings2,
  Users,
} from 'lucide-react';
import type { ProjectDetail } from '@aime/shared/projects';
import type { ThreadSummary } from '@aime/shared/threads';
import { useAuthSession } from '@/features/auth/session-context';
import { ChatPanel } from '@/components/chat';
import { useProjectRunningCount } from '@/components/chat/thread-navigation-context';
import { chatErrorKey } from '@/components/chat/api';
import { ChatThreadNavigation } from '@/components/chat/chat-thread-navigation';
import { ThreadDialog } from '@/components/chat/thread-dialogs';
import {
  ThreadActivityTitle,
  ThreadStatusBadge,
  RunningThreadCount,
} from '@/components/chat/thread-activity';
import { useProjectNavigation } from './use-project-navigation';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { projectApi } from './api';
import { ProjectDialog } from './components/project-dialog';
import { MembersSheet } from './components/members-sheet';
import { SettingsSheet } from './components/settings-sheet';

export function ProjectPage() {
  const { projectId = '', threadId } = useParams({ strict: false });
  const location = useLocation();
  if (
    location.pathname.endsWith('/automations') ||
    location.pathname.endsWith('/knowledge')
  )
    return <Outlet />;
  const chat = location.pathname.startsWith(`/projects/${projectId}/threads`);
  return (
    <ProjectSession
      key={projectId}
      projectId={projectId}
      threadId={threadId}
      chat={chat}
    />
  );
}

function ProjectSession({
  projectId,
  threadId,
  chat,
}: {
  projectId: string;
  threadId?: string;
  chat: boolean;
}) {
  const { t } = useTranslation();
  const { data } = useAuthSession();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<ReturnType<typeof chatErrorKey> | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  const [sheet, setSheet] = useState<
    'edit' | 'members' | 'settings' | 'delete' | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [draftKey, setDraftKey] = useState(0);
  const [threadAction, setThreadAction] = useState<{
    thread: ThreadSummary;
    mode: 'rename' | 'delete';
  } | null>(null);
  const navigation = useProjectNavigation();
  const runningCount = useProjectRunningCount(projectId);
  const resource = navigation.threads(projectId);
  const list = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  useEffect(() => {
    const controller = new AbortController();
    void projectApi
      .get(projectId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setProject(value);
          navigation.updateProject(value);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(chatErrorKey(cause));
      });
    if (resource.getSnapshot().page < 0) void resource.loadMore();
    return () => {
      controller.abort();
    };
  }, [projectId, resource, retry, navigation]);
  const back = (
    <Button asChild variant="ghost" size="sm">
      <Link
        to={chat ? '/projects/$projectId' : '/projects'}
        params={{ projectId }}
      >
        <ArrowLeft />
        {t(chat ? 'projects.dashboard' : 'nav.projects')}
      </Link>
    </Button>
  );
  if (error)
    return (
      <div role="alert" className="space-y-4 p-6">
        {back}
        <p>{t(error)}</p>
        <Button
          variant="outline"
          onClick={() => setRetry((value) => value + 1)}
        >
          {t('providers.retry')}
        </Button>
      </div>
    );
  if (!project) return <LoadingState className="p-6" />;
  if (chat)
    return (
      <ChatPanel
        projectId={projectId}
        initialSettings={project.settings}
        threadId={threadId}
        draftKey={draftKey}
        navigation={
          <ChatThreadNavigation
            resource={resource}
            selectedId={threadId}
            onNew={() => {
              setDraftKey((value) => value + 1);
              void navigate({
                to: '/projects/$projectId/threads',
                params: { projectId },
              });
            }}
            onSelect={(id) =>
              void navigate({
                to: '/projects/$projectId/threads/$threadId',
                params: { projectId, threadId: id },
              })
            }
          />
        }
        onThreadUpdated={resource.update}
        onThreadCreated={(thread) => {
          resource.update(thread);
          void navigate({
            to: '/projects/$projectId/threads/$threadId',
            params: { projectId: projectId, threadId: thread.id },
          });
        }}
      />
    );
  return (
    <div className="space-y-7">
      <div>{back}</div>
      <PageHeader
        title={project.name}
        description={t('projects.dashboardHint')}
        actions={
          <>
            <Button asChild variant="outline">
              <Link
                to="/projects/$projectId/automations"
                params={{ projectId }}
              >
                <Clock3 />
                {t('nav.automations')}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/projects/$projectId/knowledge" params={{ projectId }}>
                <BookOpen />
                {t('nav.knowledge')}
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setSheet('members')}>
              <Users />
              {t('projects.members')}
            </Button>
            {project.role !== 'member' && (
              <Button variant="outline" onClick={() => setSheet('settings')}>
                <Settings2 />
                {t('projects.settings')}
              </Button>
            )}
            {project.role !== 'member' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('projects.actions')}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setSheet('edit')}>
                    {t('projects.edit')}
                  </DropdownMenuItem>
                  {project.role === 'owner' && (
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => setSheet('delete')}
                    >
                      {t('projects.delete')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-5">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold">{t('projects.conversations')}</h2>
          <RunningThreadCount count={runningCount} />
          <Badge variant="secondary">
            {t(`projects.role.${project.role}`)}
          </Badge>
        </div>
        <Button asChild>
          <Link
            to="/projects/$projectId/threads"
            params={{ projectId: projectId }}
          >
            <Plus />
            {t('chat.new')}
          </Link>
        </Button>
      </div>
      {list.error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 text-sm"
        >
          <p>{t(list.error)}</p>
          <Button variant="outline" onClick={() => void resource.loadMore()}>
            {t('providers.retry')}
          </Button>
        </div>
      )}
      {!list.threads.length && !list.loading && !list.error && (
        <div className="py-16 text-center">
          <MessageSquare className="mx-auto mb-4 size-8 text-muted-foreground" />
          <h3 className="font-medium">{t('projects.emptyChats')}</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('projects.emptyChatsHint')}
          </p>
        </div>
      )}
      <div className="divide-y">
        {list.threads.map((thread) => (
          <div key={thread.id} className="flex items-center gap-3 py-4">
            {isThreadActive(thread.status) && (
              <ThreadStatusBadge status={thread.status} />
            )}
            <Link
              className="min-w-0 flex-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
              to="/projects/$projectId/threads/$threadId"
              params={{ projectId: projectId, threadId: thread.id }}
            >
              <h3 className="truncate text-sm font-medium">
                <ThreadActivityTitle
                  active={isThreadActive(thread.status)}
                  className="block"
                >
                  {thread.title || t('chat.new')}
                </ThreadActivityTitle>
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('projects.updated', {
                  date: new Date(thread.updatedAt).toLocaleString(),
                })}
              </p>
            </Link>
            {!isThreadActive(thread.status) && (
              <ThreadStatusBadge status={thread.status} />
            )}
            {(project.role !== 'member' ||
              thread.createdBy === data?.user.id) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('chat.actions', {
                      title: thread.title || t('chat.new'),
                    })}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => setThreadAction({ thread, mode: 'rename' })}
                  >
                    {t('chat.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => setThreadAction({ thread, mode: 'delete' })}
                  >
                    {t('chat.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
      </div>
      {list.loading && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {t('chat.loading')}
        </p>
      )}
      {list.hasMore && !list.loading && !list.error && (
        <Button variant="outline" onClick={() => void resource.loadMore()}>
          {t('chat.moreThreads')}
        </Button>
      )}
      {sheet === 'edit' && (
        <ProjectDialog
          project={project}
          onClose={() => setSheet(null)}
          onSaved={(value) => {
            setProject({ ...project, ...value });
            navigation.updateProject(value);
          }}
        />
      )}
      {sheet === 'members' && (
        <MembersSheet project={project} onClose={() => setSheet(null)} />
      )}
      {sheet === 'settings' && (
        <SettingsSheet
          project={project}
          onClose={() => setSheet(null)}
          onSaved={(settings) => setProject({ ...project, settings })}
        />
      )}
      {threadAction && (
        <ThreadDialog
          {...threadAction}
          onClose={() => setThreadAction(null)}
          onSaved={resource.update}
          onDeleted={() => resource.remove(threadAction.thread.id)}
        />
      )}
      {sheet === 'delete' && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !deleting) setSheet(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('projects.delete')}</DialogTitle>
              <DialogDescription>{t('projects.deleteHint')}</DialogDescription>
            </DialogHeader>
            <p className="truncate font-medium">{project.name}</p>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={deleting}
                onClick={() => setSheet(null)}
              >
                {t('users.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={deleting}
                onClick={() => {
                  if (deleting) return;
                  setDeleting(true);
                  void projectApi
                    .remove(projectId)
                    .then(() => {
                      navigation.removeProject(projectId);
                      toast.success(t('projects.deleted'));
                      void navigate({ to: '/projects' });
                    })
                    .catch((cause) => toast.error(t(chatErrorKey(cause))))
                    .finally(() => setDeleting(false));
                }}
              >
                {t(deleting ? 'users.saving' : 'projects.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
