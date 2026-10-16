import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, LoaderCircle, Monitor, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { MAX_IMAGE_BYTES } from '@aime/shared/threads';
import { usePromptInputAttachments } from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ImageCropDialog } from '@/components/image-crop-dialog';
import { canCaptureScreenshot, captureScreenshot } from '@/lib/screenshot';

export function ComposerAttachmentMenu({
  disabled,
  capturing,
  onCapturingChange,
}: {
  disabled: boolean;
  capturing: boolean;
  onCapturingChange: (capturing: boolean) => void;
}) {
  const { t } = useTranslation();
  const attachments = usePromptInputAttachments();
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const active = useRef<AbortController | null>(null);
  const current = useRef({ add: attachments.add, disabled });
  useLayoutEffect(() => {
    current.current = { add: attachments.add, disabled };
  });
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );

  async function capture() {
    if (disabled || active.current) return;
    if (!canCaptureScreenshot()) {
      toast.error(t('chat.screenshot.unsupported'));
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    onCapturingChange(true);
    let editing = false;
    try {
      const file = await captureScreenshot({
        signal: controller.signal,
      });
      if (file && !controller.signal.aborted && !current.current.disabled) {
        editing = true;
        setScreenshot(file);
      }
    } catch {
      if (!controller.signal.aborted) toast.error(t('chat.screenshot.failed'));
    } finally {
      active.current = null;
      if (!controller.signal.aborted && !editing) onCapturingChange(false);
    }
  }

  const label = t(capturing ? 'chat.screenshot.capturing' : 'chat.attachMenu');
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-7 @xl/chat:size-8"
            disabled={disabled || capturing}
            aria-label={label}
            aria-busy={capturing}
            title={label}
          >
            {capturing ? <LoaderCircle className="animate-spin" /> : <Plus />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          <DropdownMenuItem
            disabled={disabled}
            onSelect={attachments.openFileDialog}
            title={t('chat.fileHint')}
          >
            <ImagePlus />
            {t('chat.attach')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={disabled || capturing}
            onSelect={() => void capture()}
            title={t('chat.screenshot.hint')}
          >
            <Monitor />
            {t('chat.screenshot.action')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {screenshot && (
        <ImageCropDialog
          file={screenshot}
          maxBytes={MAX_IMAGE_BYTES}
          onCancel={() => {
            setScreenshot(null);
            onCapturingChange(false);
          }}
          onConfirm={(file) => {
            if (!current.current.disabled) current.current.add([file]);
            setScreenshot(null);
            onCapturingChange(false);
          }}
        />
      )}
    </>
  );
}
