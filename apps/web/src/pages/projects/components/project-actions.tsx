import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ProjectSummary } from '@aime/shared/projects';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { chatErrorKey } from '@/components/chat/api';
import { projectApi } from '../api';
import { useProjectNavigation } from '../use-project-navigation';
import { ProjectDialog } from './project-dialog';

export function ProjectActions({
  project,
  showOpen = false,
  onNavigate,
  className,
}: {
  project: ProjectSummary;
  showOpen?: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const navigation = useProjectNavigation();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const update = async (action: 'pin' | 'archive') => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const value = await (action === 'pin'
        ? projectApi.pin(project.id, !project.pinned)
        : projectApi.setArchived(project.id, !project.archived));
      navigation.updateProject(value);
      toast.success(
        t(
          action === 'pin'
            ? value.pinned
              ? 'projects.pinnedSuccess'
              : 'projects.unpinnedSuccess'
            : value.archived
              ? 'projects.archivedSuccess'
              : 'projects.restoredSuccess',
        ),
      );
    } catch (cause) {
      toast.error(t(chatErrorKey(cause)));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={className}
            disabled={pending}
            aria-label={t('projects.moreNamed', { name: project.name })}
            title={t('projects.more')}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {showOpen && (
            <DropdownMenuItem asChild>
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                onClick={onNavigate}
              >
                <ArrowUpRight />
                {t('projects.dashboard')}
              </Link>
            </DropdownMenuItem>
          )}
          {project.role !== 'member' && (
            <DropdownMenuItem
              onSelect={() => setEditing(true)}
              disabled={pending}
            >
              <Pencil />
              {t('projects.edit')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => void update('pin')}
            disabled={pending}
          >
            {project.pinned ? <PinOff /> : <Pin />}
            {t(project.pinned ? 'projects.unpin' : 'projects.pin')}
          </DropdownMenuItem>
          {project.role !== 'member' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void update('archive')}
                disabled={pending}
              >
                {project.archived ? <ArchiveRestore /> : <Archive />}
                {t(project.archived ? 'projects.restore' : 'projects.archive')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {editing && (
        <ProjectDialog
          project={project}
          onClose={() => setEditing(false)}
          onSaved={navigation.updateProject}
        />
      )}
    </>
  );
}
