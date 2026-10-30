import { Link, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocalAgentsManager } from '@/components/local-agents/manager';

export function ProjectAgentsPage() {
  const { projectId = '' } = useParams({ strict: false });
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/projects/$projectId" params={{ projectId }}>
          <ArrowLeft />
          {t('projects.dashboard')}
        </Link>
      </Button>
      <LocalAgentsManager scope={{ scope: 'project', projectId }} />
    </div>
  );
}
