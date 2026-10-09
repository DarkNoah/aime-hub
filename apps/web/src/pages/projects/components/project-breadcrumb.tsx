import { useSyncExternalStore } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useProjectNavigation } from '../use-project-navigation';

export function ProjectBreadcrumb({ projectId }: { projectId: string }) {
  const { projects, archivedProjects } = useProjectNavigation();
  const activeProject = useSyncExternalStore(
    projects.subscribe,
    () => projects.getProject(projectId),
    () => projects.getProject(projectId),
  );
  const archivedProject = useSyncExternalStore(
    archivedProjects.subscribe,
    () => archivedProjects.getProject(projectId),
    () => archivedProjects.getProject(projectId),
  );
  const project = activeProject ?? archivedProject;
  if (!project) return null;
  return (
    <>
      <ChevronRight
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        title={project.name}
        className="min-w-0 truncate rounded-sm font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
      >
        {project.name}
      </Link>
    </>
  );
}
