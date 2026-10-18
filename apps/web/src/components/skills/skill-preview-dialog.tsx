import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstalledSkill, SkillContent } from '@aime/shared/skills';
import type { TranslationKey } from '@/i18n/config';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getSkillApi, skillErrorKey, type SkillScope } from './api';
import { SkillMarkdown } from './skill-markdown';

export function SkillPreviewDialog({
  scope,
  skill,
  onClose,
}: {
  scope: SkillScope;
  skill: InstalledSkill;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = getSkillApi(scope);
  const [data, setData] = useState<SkillContent>();
  const [error, setError] = useState<TranslationKey>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .read({ query: { path: skill.path } }, { signal: controller.signal })
      .then(
        (result) => {
          if (!controller.signal.aborted) setData(result);
        },
        (cause) => {
          if (!controller.signal.aborted) setError(skillErrorKey(cause));
        },
      );
    return () => controller.abort();
  }, [client, skill.path, revision]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex h-[min(85dvh,56rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b px-5 py-5 pr-14 sm:px-6">
          <DialogTitle className="break-all">{skill.name}</DialogTitle>
          <DialogDescription className="break-all">
            {skill.path ? `${skill.path}/` : ''}SKILL.md
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div role="alert" className="space-y-4 p-6 text-sm">
            <p className="text-destructive">{t(error)}</p>
            <Button
              variant="outline"
              onClick={() => {
                setError(undefined);
                setRevision((value) => value + 1);
              }}
            >
              {t('skills.retry')}
            </Button>
          </div>
        ) : data ? (
          <Tabs defaultValue="preview" className="min-h-0 flex-1 gap-0">
            <TabsList className="mx-5 my-3 shrink-0 self-start sm:mx-6">
              <TabsTrigger value="preview">{t('skills.preview')}</TabsTrigger>
              <TabsTrigger value="source">
                {t('skills.sourceContent')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="preview" className="min-h-0 flex-1">
              <ScrollArea
                className="h-full"
                viewportProps={{ className: '[&>div]:block!' }}
              >
                <div className="min-w-0 space-y-5 px-5 pb-6 sm:px-6">
                  <SkillMarkdown content={data.content} />
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="source" className="min-h-0 flex-1">
              <ScrollArea
                className="h-full"
                viewportProps={{ className: '[&>div]:block!' }}
              >
                <pre className="px-5 pb-6 font-mono text-xs leading-6 break-words whitespace-pre-wrap sm:px-6">
                  {data.content}
                </pre>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        ) : (
          <div
            role="status"
            aria-label={t('skills.loadingContent')}
            className="space-y-4 p-6"
          >
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
