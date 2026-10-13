import { FolderPlusIcon, GitBranchIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function ProjectSourceFields({
  method,
  onMethodChange,
  repositoryUrl,
  onRepositoryUrlChange,
  branch,
  onBranchChange,
  errors,
  disabled,
}: {
  method: 'blank' | 'github';
  onMethodChange: (method: 'blank' | 'github') => void;
  repositoryUrl: string;
  onRepositoryUrlChange: (value: string) => void;
  branch: string;
  onBranchChange: (value: string) => void;
  errors: Record<string, string>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Tabs
      value={method}
      onValueChange={(value) => onMethodChange(value as 'blank' | 'github')}
      className="gap-4"
    >
      <TabsList className="w-full" aria-label={t('projects.creationMethod')}>
        <TabsTrigger value="blank" disabled={disabled}>
          <FolderPlusIcon aria-hidden="true" />
          {t('projects.blank')}
        </TabsTrigger>
        <TabsTrigger value="github" disabled={disabled}>
          <GitBranchIcon aria-hidden="true" />
          {t('projects.github.title')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="blank" className="text-sm text-muted-foreground">
        {t('projects.blankHint')}
      </TabsContent>
      <TabsContent value="github" className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="project-repository">
            {t('projects.github.repository')}
          </Label>
          <Input
            id="project-repository"
            value={repositoryUrl}
            onChange={(event) => onRepositoryUrlChange(event.target.value)}
            placeholder="https://github.com/owner/repository"
            maxLength={300}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            aria-invalid={!!errors.repositoryUrl}
            aria-describedby={`project-repository-hint${errors.repositoryUrl ? ' project-repository-error' : ''}`}
          />
          <p
            id="project-repository-hint"
            className="text-sm text-muted-foreground"
          >
            {t('projects.github.repositoryHint')}
          </p>
          {errors.repositoryUrl && (
            <p
              id="project-repository-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {errors.repositoryUrl}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="project-branch">{t('projects.github.branch')}</Label>
          <Input
            id="project-branch"
            value={branch}
            onChange={(event) => onBranchChange(event.target.value)}
            placeholder={t('projects.github.branchPlaceholder')}
            maxLength={255}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={!!errors.branch}
            aria-describedby={
              errors.branch ? 'project-branch-error' : undefined
            }
          />
          {errors.branch && (
            <p
              id="project-branch-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {errors.branch}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Badge variant="secondary">
            {t('projects.github.localFilesystem')}
          </Badge>
          <p className="text-sm text-muted-foreground">
            {t('projects.github.localHint')}
          </p>
        </div>
      </TabsContent>
    </Tabs>
  );
}
