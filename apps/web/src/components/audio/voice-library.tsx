import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AudioLines,
  Check,
  Ellipsis,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Voice } from '@aime/shared/audio';
import {
  VoiceSelector,
  VoiceSelectorContent,
  VoiceSelectorEmpty,
  VoiceSelectorGroup,
  VoiceSelectorInput,
  VoiceSelectorItem,
  VoiceSelectorList,
  VoiceSelectorName,
} from '@/components/ai-elements/voice-selector';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Item, ItemContent, ItemDescription } from '@/components/ui/item';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AudioClip } from './audio-clip';
import { audioApi, audioErrorKey } from './api';
import { VoiceEditor } from './voice-editor';

export function VoiceLibrary({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (voice: Voice) => void;
}) {
  const { t } = useTranslation();
  const [voices, setVoices] = useState<(Voice & { key: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [editing, setEditing] = useState<Voice | 'new'>();
  const [deleting, setDeleting] = useState<Voice>();
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const selected = voices.find((voice) => voice.audioPath === selectedPath);
  useEffect(() => {
    const controller = new AbortController();
    void audioApi
      .list(controller.signal)
      .then(({ voices }) => {
        if (!controller.signal.aborted)
          setVoices(
            voices.map((voice) => ({ ...voice, key: voice.audioPath })),
          );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(t(audioErrorKey(cause)));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision, t]);

  function replace(voice: Voice, previousPath?: string) {
    setVoices((current) =>
      current.some((item) => item.audioPath === previousPath)
        ? current.map((item) =>
            item.audioPath === previousPath
              ? { ...voice, key: item.key }
              : item,
          )
        : [...current, { ...voice, key: voice.audioPath }],
    );
    setSelectedPath((current) =>
      !previousPath || current === previousPath ? voice.audioPath : current,
    );
  }
  async function share(voice: Voice, shared: boolean) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    try {
      replace(await audioApi.update({ ...voice, shared }), voice.audioPath);
      toast.success(t('voices.saved'));
    } catch (cause) {
      toast.error(t(audioErrorKey(cause)));
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  async function remove(voice: Voice) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    try {
      await audioApi.remove(voice.audioPath);
      setVoices((items) =>
        items.filter((item) => item.audioPath !== voice.audioPath),
      );
      setSelectedPath((current) =>
        current === voice.audioPath ? undefined : current,
      );
      setDeleting(undefined);
      toast.success(t('voices.deleted'));
    } catch (cause) {
      toast.error(t(audioErrorKey(cause)));
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <VoiceSelector
        open
        value={selectedPath}
        onValueChange={setSelectedPath}
        onOpenChange={(open) => {
          if (!open && !editing && !deleting && !busy) onClose();
        }}
      >
        <VoiceSelectorContent
          title={t('voices.title')}
          className="max-h-[90dvh] gap-0 overflow-hidden sm:max-w-2xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchInput.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document
              .querySelector<HTMLTextAreaElement>(
                '[data-chat-composer] textarea',
              )
              ?.focus();
          }}
        >
          <div className="flex items-center gap-3 border-b p-4 pr-12">
            <AudioLines className="size-5 text-primary" />
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">{t('voices.title')}</h2>
              <p className="text-xs text-muted-foreground">
                {t('voices.libraryHint')}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => setEditing('new')}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Plus />
              {t('voices.create')}
            </Button>
          </div>
          <VoiceSelectorInput
            ref={searchInput}
            placeholder={t('voices.search')}
          />
          <ScrollArea viewportProps={{ className: 'max-h-[min(55dvh,28rem)]' }}>
            <VoiceSelectorList className="max-h-none overflow-visible">
              {loading ? (
                <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t('voices.loading')}
                </div>
              ) : error ? (
                <div
                  role="alert"
                  className="space-y-2 p-4 text-sm text-destructive"
                >
                  {error}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setLoading(true);
                      setError('');
                      setRevision((value) => value + 1);
                    }}
                  >
                    {t('voices.retry')}
                  </Button>
                </div>
              ) : (
                <>
                  <VoiceSelectorEmpty>{t('voices.empty')}</VoiceSelectorEmpty>
                  <VoiceSelectorGroup className="p-2">
                    {voices.map((voice) => (
                      <VoiceLibraryItem
                        key={voice.key}
                        voice={voice}
                        selected={voice.audioPath === selectedPath}
                        busy={busy}
                        onSelect={() => setSelectedPath(voice.audioPath)}
                        onShare={(shared) => void share(voice, shared)}
                        onEdit={() => setEditing(voice)}
                        onDelete={() => setDeleting(voice)}
                      />
                    ))}
                  </VoiceSelectorGroup>
                </>
              )}
            </VoiceSelectorList>
          </ScrollArea>
          <div className="flex min-w-0 items-center justify-end gap-3 border-t px-4 py-3">
            {selected && (
              <p className="mr-auto truncate text-sm text-muted-foreground">
                {selected.name}
              </p>
            )}
            <Button
              type="button"
              size="sm"
              disabled={busy || !selected}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={() => {
                if (!selected) return;
                onSelect(selected);
                onClose();
              }}
            >
              {t('voices.use')}
            </Button>
          </div>
        </VoiceSelectorContent>
      </VoiceSelector>
      {editing && (
        <VoiceEditor
          voice={editing === 'new' ? undefined : editing}
          onSaved={(voice) =>
            replace(voice, editing === 'new' ? undefined : editing.audioPath)
          }
          onClose={() => setEditing(undefined)}
          onRestoreFocus={() => searchInput.current?.focus()}
        />
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(undefined);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            searchInput.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('voices.delete')}</DialogTitle>
            <DialogDescription>
              {t('voices.deleteHint', { name: deleting?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(undefined)}
            >
              {t('tools.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (deleting) void remove(deleting);
              }}
            >
              {t('voices.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function VoiceLibraryItem({
  voice,
  selected,
  busy,
  onSelect,
  onShare,
  onEdit,
  onDelete,
}: {
  voice: Voice;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onShare: (shared: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const sharedId = useId();
  const openingDialog = useRef(false);
  return (
    <VoiceSelectorItem
      asChild
      value={voice.audioPath}
      keywords={[voice.name, voice.description, voice.text]}
      onSelect={onSelect}
      aria-label={voice.name}
    >
      <Item size="sm" className="flex-col items-stretch gap-2 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <ItemContent className="min-w-0 gap-0.5">
            <VoiceSelectorName>{voice.name}</VoiceSelectorName>
            {voice.description && (
              <ItemDescription
                className="line-clamp-1 text-xs"
                title={voice.description}
              >
                {voice.description}
              </ItemDescription>
            )}
          </ItemContent>
          {selected && (
            <Check
              className="size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
          )}
          {voice.canEdit && (
            <div
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <DropdownMenu
                onOpenChange={(open) => {
                  if (open) openingDialog.current = false;
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label={t('voices.actions', { name: voice.name })}
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(event) => {
                    if (openingDialog.current) event.preventDefault();
                  }}
                >
                  <DropdownMenuItem
                    onSelect={() => {
                      openingDialog.current = true;
                      onEdit();
                    }}
                  >
                    <Pencil />
                    {t('voices.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      openingDialog.current = true;
                      onDelete();
                    }}
                  >
                    <Trash2 />
                    {t('voices.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        <div
          className="flex min-w-0 items-center gap-4"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            // Keep playback and switch keys out of the command list navigation.
            if (event.key !== 'Escape') event.stopPropagation();
          }}
        >
          <AudioClip
            compact
            src={audioApi.raw(voice.audioPath)}
            filename={voice.name}
            className="flex-1"
          />
          <div
            className="flex shrink-0 items-center gap-2"
            title={t(voice.shared ? 'voices.sharedLocked' : 'voices.shareHint')}
          >
            <Label htmlFor={sharedId} className="text-xs text-muted-foreground">
              {t('voices.shared')}
            </Label>
            <Switch
              id={sharedId}
              checked={voice.shared}
              disabled={busy || voice.shared || !voice.canEdit}
              aria-label={`${t('voices.share')}: ${voice.name}`}
              aria-describedby={`${sharedId}-hint`}
              onCheckedChange={onShare}
            />
            <span id={`${sharedId}-hint`} className="sr-only">
              {t(voice.shared ? 'voices.sharedLocked' : 'voices.shareHint')}
            </span>
          </div>
        </div>
      </Item>
    </VoiceSelectorItem>
  );
}
