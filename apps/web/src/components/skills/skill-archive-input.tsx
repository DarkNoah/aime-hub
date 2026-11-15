import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileArchive, Loader2, Upload } from 'lucide-react';
import { SKILL_ARCHIVE_MAX_BYTES } from '@aime/shared/skills';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export function SkillArchiveInput({
  filename,
  loading,
  disabled,
  onFile,
  onCancel,
}: {
  filename?: string;
  loading: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={cn(
        'rounded-lg border border-dashed p-4 transition-colors',
        dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20',
      )}
      onDragEnter={(event) => {
        if (disabled || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        depth.current++;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (disabled || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (--depth.current <= 0) {
          depth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        if (disabled) return;
        if (event.dataTransfer.files.length > 1) {
          toast.error(t('skills.singleArchive'));
          return;
        }
        const file = event.dataTransfer.files[0];
        if (file) onFile(file);
      }}
    >
      <input
        ref={input}
        id={id}
        type="file"
        accept=".zip,.skill"
        data-testid="skill-archive-input"
        className="sr-only"
        tabIndex={-1}
        aria-label={t('skills.chooseArchive')}
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
      <div className="flex items-start gap-3">
        <FileArchive className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="break-all text-sm font-medium">
            {filename ?? t('skills.archiveDropHint')}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            {t('skills.archiveHint', {
              size: SKILL_ARCHIVE_MAX_BYTES / 1024 / 1024,
            })}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => input.current?.click()}
            >
              <Upload />
              {t(filename ? 'skills.replaceArchive' : 'skills.chooseArchive')}
            </Button>
            {loading ? (
              <>
                <Badge variant="secondary" role="status">
                  <Loader2 className="size-3 animate-spin" />
                  {t('skills.archiveScanning')}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onCancel}
                >
                  {t('skills.cancel')}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
