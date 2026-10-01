import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain } from 'lucide-react';
import { reasoningEfforts, type ChatSettings } from '@aime/shared/threads';
import { ModelSelector } from '@/components/model-selector';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';

export function ChatSettingsFields({
  value,
  onChange,
  disabled,
}: {
  value: ChatSettings;
  onChange: (settings: ChatSettings) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const hintId = useId();
  const [preview, setPreview] = useState<number | null>(null);
  const level = preview ?? reasoningEfforts.indexOf(value.reasoningEffort);
  const label = t(`chat.reasoning.${reasoningEfforts[level]}`);
  return (
    <>
      <div className="min-w-0 max-w-[min(11rem,38cqw)]">
        <ModelSelector
          label={t('chat.model')}
          value={value.model}
          onValueChange={(model) => onChange({ ...value, model })}
          disabled={disabled}
          noneLabel={t('chat.defaultModel')}
          textOnly
          compact
        />
      </div>
      <Popover onOpenChange={() => setPreview(null)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
            disabled={disabled}
            aria-label={`${t('chat.reasoningLevel')}: ${t(`chat.reasoning.${value.reasoningEffort}`)}`}
            title={`${t('chat.reasoningLevel')}: ${t(`chat.reasoning.${value.reasoningEffort}`)}`}
          >
            <Brain className="size-4" />
            <span className="hidden @md/chat:inline">
              {t(`chat.reasoning.${value.reasoningEffort}`)}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" aria-labelledby={labelId}>
          <div className="flex items-center justify-between gap-3">
            <p id={labelId} className="text-sm font-medium">
              {t('chat.reasoningLevel')}
            </p>
            <Badge variant="secondary">{label}</Badge>
          </div>
          <p
            id={hintId}
            className="mt-2 text-xs leading-5 text-muted-foreground"
          >
            {t('chat.reasoningHint')}
          </p>
          <Slider
            className="mt-5 mb-3 py-2"
            min={0}
            max={reasoningEfforts.length - 1}
            step={1}
            value={[level]}
            disabled={disabled}
            thumbProps={{
              'aria-labelledby': labelId,
              'aria-describedby': hintId,
              'aria-valuetext': label,
            }}
            onValueChange={([next]) => setPreview(next)}
            onValueCommit={([next]) => {
              setPreview(null);
              const reasoningEffort = reasoningEfforts[next];
              if (reasoningEffort !== value.reasoningEffort)
                onChange({ ...value, reasoningEffort });
            }}
          />
          <div
            aria-hidden="true"
            className="flex justify-between text-xs text-muted-foreground"
          >
            <span>{t('chat.reasoning.auto')}</span>
            <span>{t('chat.reasoning.max')}</span>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
