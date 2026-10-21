import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { toolConfigSchemas, type ToolConfig } from '@aime/shared/tools';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { ModelSelector } from '@/components/model-selector';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toolErrorKey } from '../api';

export function ModelToolDialog({
  tool,
  onSaved,
  onClose,
  restoreFocus,
}: {
  tool: Extract<
    ToolConfig,
    {
      kind: 'image_gen' | 'speech' | 'transcriptions' | 'read_file' | 'extract';
    }
  >;
  onSaved: (tool: ToolConfig) => void;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const speech = tool.kind === 'speech';
  const transcription = tool.kind === 'transcriptions';
  const ocr = tool.kind === 'read_file';
  const extraction = tool.kind === 'extract';
  const labels = extraction
    ? ({
        configure: 'tools.configureExtract',
        enable: 'tools.enableExtract',
        model: 'tools.extractModel',
        defaultModel: 'tools.defaultExtractModel',
        modelHint: 'tools.extractModelHint',
        providerHint: 'tools.extractProviderHint',
        invalidModel: 'tools.invalidExtractModel',
      } satisfies Record<string, TranslationKey>)
    : ocr
      ? ({
          configure: 'tools.configureViewFile',
          enable: 'tools.enableViewFile',
          model: 'tools.ocrModel',
          defaultModel: 'tools.selectOcrModel',
          modelHint: 'tools.ocrModelHint',
          providerHint: 'tools.ocrProviderHint',
          invalidModel: 'tools.invalidOcrModel',
        } satisfies Record<string, TranslationKey>)
      : ({
          configure: transcription
            ? 'tools.configureTranscriptions'
            : speech
              ? 'tools.configureSpeech'
              : 'tools.configureImage',
          enable: transcription
            ? 'tools.enableTranscriptions'
            : speech
              ? 'tools.enableSpeech'
              : 'tools.enableImage',
          model: transcription
            ? 'defaults.asrModel'
            : speech
              ? 'defaults.speechModel'
              : 'defaults.imageModel',
          defaultModel: transcription
            ? 'tools.defaultTranscriptionsModel'
            : speech
              ? 'tools.defaultSpeechModel'
              : 'tools.defaultImageModel',
          modelHint: transcription
            ? 'tools.transcriptionsModelHint'
            : speech
              ? 'tools.speechModelHint'
              : 'tools.imageModelHint',
          providerHint: transcription
            ? 'tools.transcriptionsProviderHint'
            : speech
              ? 'tools.speechProviderHint'
              : 'tools.imageProviderHint',
          invalidModel: transcription
            ? 'tools.invalidTranscriptionsModel'
            : speech
              ? 'tools.invalidSpeechModel'
              : 'tools.invalidImageModel',
        } satisfies Record<string, TranslationKey>);
  const [enabled, setEnabled] = useState(tool.config.enabled);
  const [model, setModel] = useState(tool.config.model);
  const [mode, setMode] = useState<'fast' | 'accurate'>(
    tool.kind === 'extract' ? tool.config.mode : 'accurate',
  );
  const [timeout, setTimeout] = useState(String(tool.config.timeoutMs / 1000));
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<
    Partial<Record<'model' | 'timeout' | 'form', TranslationKey>>
  >({});
  const submitting = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const parsed = toolConfigSchemas[tool.kind].safeParse({
      enabled,
      model,
      timeoutMs: Number(timeout) * 1000,
      ...(extraction ? { mode } : {}),
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'timeoutMs')
          next.timeout = extraction
            ? 'tools.extractTimeoutHint'
            : 'tools.imageTimeoutHint';
        else next.model = labels.invalidModel;
      }
      setErrors(next);
      return;
    }
    submitting.current = true;
    setPending(true);
    setErrors({});
    try {
      const saved = await api.tools.update({
        params: { toolId: tool.kind },
        body: parsed.data,
      });
      onSaved(saved);
      toast.success(t('tools.saved'));
      onClose();
    } catch (error) {
      const key = toolErrorKey(error, tool.kind);
      setErrors({ form: key });
      toast.error(t(key));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col sm:max-w-lg"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={(event) => {
          if (submitting.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t(labels.configure)}</DialogTitle>
          <DialogDescription>{t('tools.applyHint')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={submit}
          noValidate
          className="flex min-h-0 flex-col gap-5"
        >
          <ScrollArea
            className="min-h-0"
            viewportProps={{ className: 'max-h-[60dvh]' }}
          >
            <fieldset disabled={pending} className="space-y-5 p-1">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="generation-enabled">{t(labels.enable)}</Label>
                <Switch
                  id="generation-enabled"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={pending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="generation-model">{t(labels.model)}</Label>
                <ModelSelector
                  id="generation-model"
                  label={t(labels.model)}
                  modelType={
                    extraction
                      ? 'language'
                      : ocr
                        ? 'ocr'
                        : transcription
                          ? 'asr'
                          : speech
                            ? 'speech'
                            : 'image'
                  }
                  value={model}
                  onValueChange={setModel}
                  disabled={pending}
                  noneLabel={t(labels.defaultModel)}
                />
                <p
                  className={
                    errors.model
                      ? 'text-xs text-destructive'
                      : 'text-xs leading-5 text-muted-foreground'
                  }
                >
                  {t(errors.model ?? labels.modelHint)}
                </p>
              </div>
              {extraction && (
                <div className="space-y-2">
                  <Label htmlFor="extraction-mode">
                    {t('tools.extractMode')}
                  </Label>
                  <Select
                    value={mode}
                    onValueChange={(value) =>
                      setMode(value as 'fast' | 'accurate')
                    }
                    disabled={pending}
                  >
                    <SelectTrigger id="extraction-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="accurate">
                        {t('tools.extractAccurate')}
                      </SelectItem>
                      <SelectItem value="fast">
                        {t('tools.extractFast')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t('tools.extractModeHint')}
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="generation-timeout">{t('tools.timeout')}</Label>
                <Input
                  id="generation-timeout"
                  type="number"
                  min={1}
                  max={600}
                  step={1}
                  value={timeout}
                  onChange={(event) => setTimeout(event.target.value)}
                  aria-invalid={!!errors.timeout}
                  aria-describedby="generation-timeout-hint"
                />
                <p
                  id="generation-timeout-hint"
                  className={
                    errors.timeout
                      ? 'text-xs text-destructive'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  {t(
                    extraction
                      ? 'tools.extractTimeoutHint'
                      : 'tools.imageTimeoutHint',
                  )}
                </p>
              </div>
              <p className="rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
                {t(labels.providerHint)}
              </p>
              {errors.form && (
                <p role="alert" className="text-sm text-destructive">
                  {t(errors.form)}
                </p>
              )}
            </fieldset>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('tools.cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              {t(pending ? 'tools.saving' : 'tools.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
