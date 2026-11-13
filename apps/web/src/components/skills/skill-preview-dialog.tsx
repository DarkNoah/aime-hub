import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstalledSkill } from '@aime/shared/skills';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { FileTree } from '@/components/file-manager/file-tree';
import { FilePreview } from '@/components/file-manager/file-preview';
import { DiscardEditsDialog } from '@/components/file-manager/discard-edits-dialog';
import { useFileEdits } from '@/components/file-manager/use-file-edits';
import type { SkillScope } from './api';
import { createSkillFileClient } from './file-client';
import { useSkillFiles } from './use-skill-files';

export function SkillPreviewDialog({
  scope,
  skill,
  root,
  onUpdated,
  onClose,
}: {
  scope: SkillScope;
  skill: InstalledSkill;
  root: string;
  onUpdated: (skill: InstalledSkill) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [client] = useState(() =>
    createSkillFileClient(scope, skill.path, onUpdated),
  );
  const state = useSkillFiles(client);
  const edits = useFileEdits(client);
  const [closing, setClosing] = useState(false);
  const [stacked, setStacked] = useState(
    () => window.matchMedia('(max-width: 639px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const update = () => setStacked(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const dirtyCount = Object.keys(edits.drafts).filter(edits.isDirty).length;
  const saving = Object.keys(edits.drafts).some(edits.isSaving);
  function close() {
    if (saving) return;
    if (dirtyCount) setClosing(true);
    else onClose();
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent
          className="flex h-[90dvh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl"
          showCloseButton={!saving}
        >
          <DialogHeader className="shrink-0 border-b px-5 py-4 pr-14 text-left">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="break-all">{skill.name}</DialogTitle>
              {dirtyCount > 0 && (
                <Badge variant="outline">
                  {t('skills.unsavedFiles', { count: dirtyCount })}
                </Badge>
              )}
            </div>
            <DialogDescription className="break-all font-mono text-xs">
              {root}/{skill.path ? `${skill.path}/` : ''}
            </DialogDescription>
          </DialogHeader>
          <ResizablePanelGroup
            orientation={stacked ? 'vertical' : 'horizontal'}
            className="flex-1"
          >
            <ResizablePanel
              defaultSize={stacked ? '28%' : '24%'}
              minSize={stacked ? 80 : 180}
              maxSize="55%"
              className="flex min-h-0 min-w-0 flex-col bg-muted/20"
            >
              <div className="flex h-10 shrink-0 items-center border-b px-4 text-xs font-medium">
                {t('skills.packageFiles')}
              </div>
              <ScrollArea
                className="min-h-0 flex-1"
                viewportProps={{ className: '[&>div]:!block' }}
              >
                <FileTree state={state} />
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </ResizablePanel>
            <ResizableHandle
              aria-label={t(
                stacked ? 'files.resizeTreeHeight' : 'files.resizeTreeWidth',
              )}
            />
            <ResizablePanel
              minSize={stacked ? 180 : 320}
              className="min-h-0 min-w-0"
            >
              <FilePreview
                key={state.selected}
                client={client}
                path={state.selected}
                revision={0}
                edits={edits}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </DialogContent>
      </Dialog>
      <DiscardEditsDialog
        open={closing}
        onCancel={() => setClosing(false)}
        onDiscard={onClose}
      />
    </>
  );
}
