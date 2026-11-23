import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorCode } from '@/lib/rpc';
import { groupChatApi, groupChatErrorKey } from '../api';

type GeneratorProps = {
  roomId: string;
  agentId: string;
  onSelect: (file: File) => boolean;
};

export function RoomAgentAvatarGenerator(props: GeneratorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Sparkles aria-hidden="true" />
          {t('groupChat.avatarGenerator')}
        </Button>
      </DialogTrigger>
      {open && <GeneratorDialog {...props} onClose={() => setOpen(false)} />}
    </Dialog>
  );
}

function GeneratorDialog({
  roomId,
  agentId,
  onSelect,
  onClose,
}: GeneratorProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<{ file: File; url: string }>();
  const [generating, setGenerating] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );

  async function generate() {
    if (active.current || !prompt.trim()) return;
    const controller = new AbortController();
    active.current = controller;
    setGenerating(true);
    try {
      const file = await groupChatApi.generateAgentAvatar(
        roomId,
        agentId,
        prompt.trim(),
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setPreview({ file, url: URL.createObjectURL(file) });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(t(groupChatErrorKey(error)), {
          description:
            apiErrorCode(error) === 'IMAGE_GENERATION_FAILED' &&
            error instanceof Error
              ? error.message
              : undefined,
        });
      }
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setGenerating(false);
    }
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t('groupChat.avatarGenerator')}</DialogTitle>
        <DialogDescription>
          {t('groupChat.avatarGeneratorHint')}
        </DialogDescription>
      </DialogHeader>
      <ScrollArea viewportProps={{ className: 'max-h-[50dvh]' }}>
        <div className="space-y-3 p-1">
          <div className="space-y-2">
            <Label htmlFor={id}>{t('groupChat.avatarPrompt')}</Label>
            <Textarea
              id={id}
              rows={3}
              maxLength={32000}
              className="field-sizing-fixed resize-none"
              placeholder={t('groupChat.avatarPromptExample')}
              value={prompt}
              disabled={generating}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>
          {preview && (
            <img
              className="mx-auto size-32 rounded-full border object-cover"
              src={preview.url}
              alt={t('groupChat.avatarPreview')}
            />
          )}
        </div>
      </ScrollArea>
      <DialogFooter className="flex-row flex-wrap justify-end">
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t('agents.cancel')}
          </Button>
        </DialogClose>
        <Button
          type="button"
          variant={preview ? 'outline' : 'default'}
          disabled={generating || !prompt.trim()}
          onClick={() => void generate()}
        >
          {generating && (
            <LoaderCircle
              className="motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          {t(
            generating
              ? 'groupChat.avatarGenerating'
              : preview
                ? 'groupChat.avatarRegenerate'
                : 'groupChat.avatarGenerate',
          )}
        </Button>
        {preview && (
          <Button
            type="button"
            disabled={generating}
            onClick={() => {
              if (onSelect(preview.file)) onClose();
            }}
          >
            {t('groupChat.avatarUse')}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
