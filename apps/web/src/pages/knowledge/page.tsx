import { Link, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { KnowledgeManager } from '@/components/knowledge/manager';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

export function KnowledgePage() {
  const { projectId } = useParams({ strict: false });
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      {projectId && (
        <Button asChild variant="ghost" size="sm">
          <Link to="/projects/$projectId" params={{ projectId }}>
            <ArrowLeft />
            {t('projects.dashboard')}
          </Link>
        </Button>
      )}
      <PageHeader
        title={t('nav.knowledge')}
        description={t(
          projectId ? 'knowledge.projectHint' : 'knowledge.pageHint',
        )}
      />
      <KnowledgeManager projectId={projectId} />
    </div>
  );
}
