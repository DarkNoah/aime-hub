import { useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Folder, Plus, Pencil } from 'lucide-react';
import type { ProjectSummary } from '@aime/shared/projects';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useProjectNavigation } from './use-project-navigation';
import { ProjectSheet } from './components/project-sheet';

export function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projects: resource } = useProjectNavigation();
  const { projects, hasMore, loading, error } = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  const [edit, setEdit] = useState<ProjectSummary | 'new' | null>(null);
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
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 rounded-lg border p-4 text-sm"
        >
          <span>{t(error)}</span>
          <Button variant="outline" onClick={() => void resource.loadMore()}>
            {t('providers.retry')}
          </Button>
        </div>
      )}
      <div className="divide-y rounded-xl border bg-card">
        {!projects.length && !loading && !error && (
          <div className="px-6 py-16 text-center">
            <Folder className="mx-auto mb-4 size-8 text-muted-foreground" />
            <h2 className="font-medium">{t('projects.empty')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('projects.emptyHint')}
            </p>
          </div>
        )}
        {projects.map((project) => (
          <div
            key={project.id}
            className="flex items-center gap-3 px-5 py-5 sm:px-6"
          >
            <Folder className="hidden size-5 shrink-0 text-primary sm:block" />
            <Link
              className="min-w-0 flex-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
              to={`/projects/${project.id}`}
            >
              <h2 className="truncate font-medium">{project.name}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('projects.updated', {
                  date: new Date(project.updatedAt).toLocaleDateString(),
                })}
              </p>
            </Link>
            <Badge variant="secondary">
              {t(`projects.role.${project.role}`)}
            </Badge>
            {project.role !== 'member' && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('projects.editNamed', { name: project.name })}
                onClick={() => setEdit(project)}
              >
                <Pencil />
              </Button>
            )}
            <ArrowUpRight className="hidden size-4 text-muted-foreground sm:block" />
          </div>
        ))}
        {loading && (
          <p
            role="status"
            className="p-6 text-center text-sm text-muted-foreground"
          >
            {t('common.loading')}
          </p>
        )}
      </div>
      {hasMore && !loading && !error && (
        <Button
          className="mx-auto flex"
          variant="outline"
          onClick={() => void resource.loadMore()}
        >
          {t('projects.loadMore')}
        </Button>
      )}
      {edit && (
        <ProjectSheet
          project={edit === 'new' ? undefined : edit}
          onClose={() => setEdit(null)}
          onSaved={(value) => {
            resource.update(value);
            if (edit === 'new') navigate(`/projects/${value.id}`);
          }}
        />
      )}
    </div>
  );
}
