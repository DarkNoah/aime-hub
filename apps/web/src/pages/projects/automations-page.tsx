import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { AutomationManager } from '@/components/automations/manager';
import { Button } from '@/components/ui/button';
import { projectApi } from './api';

export function ProjectAutomationsPage() {
  const { projectId = '' } = useParams({ strict: false });
  const { t } = useTranslation();
  const [project, setProject] = useState<{ id: string; name: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void projectApi
      .get(projectId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setProject(value);
      })
      .catch(() => {}); // The shared manager displays scope access/load failures.
    return () => controller.abort();
  }, [projectId]);
  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/projects/$projectId" params={{ projectId }}>
          <ArrowLeft />
          {t('projects.dashboard')}
        </Link>
      </Button>
      <AutomationManager
        scope={{ scope: 'project', projectId }}
        projectName={
          project && project.id === projectId ? project.name : undefined
        }
      />
    </div>
  );
}
