import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { Voice } from '@aime/shared/audio';
import { ModelSelector } from '@/components/model-selector';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AudioClip } from './audio-clip';
import { audioApi, audioErrorKey } from './api';

export function VoiceEditor({
  voice,
  onSaved,
  onClose,
  onRestoreFocus,
}: {
  voice?: Voice;
  onSaved: (voice: Voice) => void;
  onClose: () => void;
  onRestoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState('generate');
  const [name, setName] = useState(voice?.name ?? '');
  const [description, setDescription] = useState(voice?.description ?? '');
  const [text, setText] = useState(voice?.text ?? '');
  const [shared, setShared] = useState(voice?.shared ?? false);
  const [model, setModel] = useState<string | null>(null);
  const [instructions, setInstructions] = useState('');
  const [preset, setPreset] = useState('');
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [pending, setPending] = useState<'save' | 'transcribe' | null>(null);
  const [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    if (preview) return () => URL.revokeObjectURL(preview);
  }, [preview]);

  async function recognize() {
    if (!file || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending('transcribe');
    setError('');
    try {
      const result = await audioApi.transcribe(file, controller.signal);
      if (!controller.signal.aborted) {
        setText(result.text);
        toast.success(t('voices.transcribed'));
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = t(audioErrorKey(cause));
        setError(message);
        toast.error(message);
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setPending(null);
      }
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (operation.current) return;
    if (
      !name.trim() ||
      !text.trim() ||
      (!voice && mode === 'upload' && !file)
    ) {
      setError(t('voices.required'));
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setPending('save');
    setError('');
    try {
      const input = {
        name: name.trim(),
        description: description.trim(),
        text: text.trim(),
        shared,
      };
      const saved = voice
        ? await audioApi.update(
            { ...input, audioPath: voice.audioPath },
            controller.signal,
          )
        : mode === 'upload'
          ? await audioApi.upload(file!, input, controller.signal)
          : await audioApi.generate(
              {
                ...input,
                model: model ?? undefined,
                instructions: instructions.trim() || undefined,
                voice: preset.trim() || undefined,
              },
              controller.signal,
            );
      if (!controller.signal.aborted) {
        onSaved(saved);
        toast.success(t('voices.saved'));
        onClose();
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = t(audioErrorKey(cause));
        setError(message);
        toast.error(message);
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setPending(null);
      }
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col sm:max-w-xl"
        onPointerDownOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(voice ? 'voices.edit' : 'voices.create')}
          </DialogTitle>
          <DialogDescription>{t('voices.editorHint')}</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-col gap-4" onSubmit={save}>
          <ScrollArea
            className="min-h-0"
            viewportProps={{ className: 'max-h-[62dvh]' }}
          >
            <fieldset disabled={!!pending} className="space-y-4 p-1">
              {!voice && (
                <Tabs
                  value={mode}
                  onValueChange={(value) => {
                    setMode(value);
                    setError('');
                  }}
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="generate" disabled={!!pending}>
                      <AudioLines />
                      {t('voices.generate')}
                    </TabsTrigger>
                    <TabsTrigger value="upload" disabled={!!pending}>
                      <Upload />
                      {t('voices.upload')}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
              <div className="space-y-2">
                <Label htmlFor="voice-name">{t('voices.name')}</Label>
                <Input
                  id="voice-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="voice-description">
                  {t('voices.description')}
                </Label>
                <Textarea
                  id="voice-description"
                  value={description}
                  maxLength={4000}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('voices.descriptionHint')}
                />
              </div>
              {!voice && mode === 'upload' && (
                <div className="space-y-2">
                  <Label htmlFor="voice-file">{t('voices.audioFile')}</Label>
                  <Input
                    id="voice-file"
                    type="file"
                    accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm"
                    onChange={(event) => {
                      const next = event.target.files?.[0];
                      if (next && next.size > 20000000) {
                        setError(t('voices.tooLarge'));
                        setFile(undefined);
                        setPreview(undefined);
                        event.target.value = '';
                        return;
                      }
                      setFile(next);
                      setPreview(next ? URL.createObjectURL(next) : undefined);
                      setText('');
                      setError('');
                      if (next && !name)
                        setName(next.name.replace(/\.[^.]+$/, ''));
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('voices.uploadHint')}
                  </p>
                  {file && preview && (
                    <AudioClip src={preview} filename={file.name} />
                  )}
                </div>
              )}
              {!voice && mode === 'generate' && (
                <>
                  <div className="space-y-2">
                    <Label>{t('defaults.speechModel')}</Label>
                    <ModelSelector
                      value={model}
                      onValueChange={setModel}
                      modelType="speech"
                      label={t('defaults.speechModel')}
                      noneLabel={t('tools.defaultSpeechModel')}
                      disabled={!!pending}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="voice-instructions">
                      {t('voices.instructions')}
                    </Label>
                    <Textarea
                      id="voice-instructions"
                      value={instructions}
                      onChange={(event) => setInstructions(event.target.value)}
                      placeholder={t('voices.instructionsHint')}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="voice-preset">{t('voices.preset')}</Label>
                    <Input
                      id="voice-preset"
                      value={preset}
                      onChange={(event) => setPreset(event.target.value)}
                      placeholder={t('voices.presetHint')}
                    />
                  </div>
                </>
              )}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="voice-text">{t('voices.text')}</Label>
                  {!voice && mode === 'upload' && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!file || !!pending}
                      onClick={() => void recognize()}
                    >
                      {pending === 'transcribe' ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <AudioLines />
                      )}
                      {t('voices.recognize')}
                    </Button>
                  )}
                </div>
                <Textarea
                  id="voice-text"
                  className="min-h-28"
                  value={text}
                  maxLength={32000}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={t('voices.textHint')}
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="space-y-1">
                  <Label htmlFor="voice-shared">{t('voices.share')}</Label>
                  <p
                    id="voice-share-hint"
                    className="text-xs text-muted-foreground"
                  >
                    {t(
                      voice?.shared
                        ? 'voices.sharedLocked'
                        : 'voices.shareHint',
                    )}
                  </p>
                </div>
                <Switch
                  id="voice-shared"
                  checked={shared}
                  onCheckedChange={setShared}
                  disabled={!!pending || voice?.shared}
                  aria-describedby="voice-share-hint"
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </fieldset>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (pending) operation.current?.abort();
                else onClose();
              }}
            >
              {t(pending ? 'voices.cancelOperation' : 'tools.cancel')}
            </Button>
            <Button type="submit" disabled={!!pending}>
              {pending === 'save' && <Loader2 className="animate-spin" />}
              {t(
                !voice && mode === 'generate'
                  ? 'voices.generateSave'
                  : 'tools.save',
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
