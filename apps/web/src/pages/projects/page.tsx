import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Folder, Plus } from 'lucide-react';
import type { ProjectSummary } from '@aime/shared/projects';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Item, ItemGroup } from '@/components/ui/item';
import { useProjectNavigation } from './use-project-navigation';
import { ProjectDialog } from './components/project-dialog';
import { ProjectActions } from './components/project-actions';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigation = useProjectNavigation();
  const [view, setView] = useState('active');
  const resource =
    view === 'archived' ? navigation.archivedProjects : navigation.projects;
  const { projects, hasMore, loading, error } = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  const [edit, setEdit] = useState<ProjectSummary | 'new' | null>(null);
  useEffect(() => {
    if (resource.getSnapshot().page < 0) void resource.loadMore();
  }, [resource]);
  return (
    <div className="space-y-8">
      <PageHeader
        title={t('nav.projects')}
        description={t('projects.description')}
        actions={
          <Button onClick={() => setEdit('new')}>
            <Plus />
            {t('projects.create')}
          </Button>
        }
      />
      <Tabs value={view} onValueChange={setView} className="gap-4">
        <TabsList aria-label={t('projects.list')}>
          <TabsTrigger value="active">{t('projects.active')}</TabsTrigger>
          <TabsTrigger value="archived">{t('projects.archived')}</TabsTrigger>
        </TabsList>
        <TabsContent value={view} className="space-y-4">
          {error && (
            <div
              role="alert"
              className="flex items-center justify-between gap-4 rounded-lg border p-4 text-sm"
            >
              <span>{t(error)}</span>
              <Button
                variant="outline"
                onClick={() => void resource.loadMore()}
              >
                {t('providers.retry')}
              </Button>
            </div>
          )}
          <ItemGroup className="gap-0 overflow-hidden rounded-xl border bg-card">
            {!projects.length && !loading && !error && (
              <div className="px-6 py-16 text-center">
                <Folder className="mx-auto mb-4 size-8 text-muted-foreground" />
                <h2 className="font-medium">
                  {t(
                    view === 'archived'
                      ? 'projects.emptyArchived'
                      : 'projects.empty',
                  )}
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t(
                    view === 'archived'
                      ? 'projects.emptyArchivedHint'
                      : 'projects.emptyHint',
                  )}
                </p>
              </div>
            )}
            {projects.map((project) => (
              <Item
                key={project.id}
                role="listitem"
                variant="ghost"
                className="project-row flex-nowrap gap-3 rounded-none border-0 border-b border-border px-5 py-5 text-base last:border-b-0 sm:px-6"
              >
                <span className="hidden size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary sm:flex">
                  <Folder className="size-5" aria-hidden />
                </span>
                <Link
                  className="min-w-0 flex-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="truncate font-medium">{project.name}</h2>
                    {project.pinned && (
                      <Badge variant="secondary" className="shrink-0">
                        {t('projects.pinned')}
                      </Badge>
                    )}
                    {project.archived && (
                      <Badge variant="outline" className="shrink-0">
                        {t('projects.archived')}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('projects.updated', {
                      date: new Date(project.updatedAt).toLocaleDateString(),
                    })}
                  </p>
                </Link>
                <Badge variant="secondary" className="hidden sm:inline-flex">
                  {t(`projects.role.${project.role}`)}
                </Badge>
                <Button asChild variant="ghost" size="icon-sm">
                  <Link
                    to="/projects/$projectId/threads"
                    params={{ projectId: project.id }}
                    aria-label={t('projects.newChatNamed', {
                      name: project.name,
                    })}
                    title={t('projects.newChatNamed', { name: project.name })}
                  >
                    <Plus />
                  </Link>
                </Button>
                <ProjectActions project={project} />
              </Item>
            ))}
            {loading && <LoadingState />}
          </ItemGroup>
          {hasMore && !loading && !error && (
            <Button
              className="mx-auto flex"
              variant="outline"
              onClick={() => void resource.loadMore()}
            >
              {t('projects.loadMore')}
            </Button>
          )}
        </TabsContent>
      </Tabs>
      {edit && (
        <ProjectDialog
          project={edit === 'new' ? undefined : edit}
          onClose={() => setEdit(null)}
          onSaved={(value) => {
            navigation.updateProject(value);
            if (edit === 'new')
              void navigate({
                to: '/projects/$projectId',
                params: { projectId: value.id },
              });
          }}
        />
      )}
    </div>
  );
}
