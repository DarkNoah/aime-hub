import { useMemo } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EnvironmentVariablesManager } from '@/components/environment-variables/manager';
import type { EnvironmentVariablesClient } from '@/components/environment-variables/api';
import { api } from '@/lib/rpc';

export function ProjectEnvironmentVariablesPage() {
  const { projectId = '' } = useParams({ strict: false });
  const { t } = useTranslation();
  const client = useMemo<EnvironmentVariablesClient>(
    () => ({
      list: (_input, options) =>
        api.projectEnvironmentVariables.list(
          { params: { projectId } },
          options,
        ),
      get: ({ params }, options) =>
        api.projectEnvironmentVariables.get(
          { params: { ...params, projectId } },
          options,
        ),
      create: ({ body }, options) =>
        api.projectEnvironmentVariables.create(
          { params: { projectId }, body },
          options,
        ),
      update: ({ params, body }, options) =>
        api.projectEnvironmentVariables.update(
          { params: { ...params, projectId }, body },
          options,
        ),
      remove: ({ params }, options) =>
        api.projectEnvironmentVariables.remove(
          { params: { ...params, projectId } },
          options,
        ),
    }),
    [projectId],
  );
  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/projects/$projectId" params={{ projectId }}>
          <ArrowLeft />
          {t('projects.dashboard')}
        </Link>
      </Button>
      <EnvironmentVariablesManager
        key={projectId}
        client={client}
        description="projects.environmentVariablesDescription"
      />
    </div>
  );
}
