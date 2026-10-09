import { ArrowUpRight, FileCode2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorkspaceFile } from './context';

export function WorkspaceFileLink({
  path,
  disabled = false,
}: {
  path: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const openFile = useWorkspaceFile();
  return (
    <Button
      variant="ghost"
      className="h-auto w-full min-w-0 justify-start gap-2 px-2 py-2 text-left"
      aria-label={t('files.openPreview', { path })}
      title={t('files.openPreview', { path })}
      disabled={disabled || !openFile || !path.trim()}
      onClick={() => openFile?.(path)}
    >
      <FileCode2
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 whitespace-normal font-mono text-xs leading-5 [overflow-wrap:anywhere]">
        {path}
      </span>
      <ArrowUpRight
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </Button>
  );
}
