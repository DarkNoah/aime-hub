import { useTranslation } from 'react-i18next';
import { reasoningEfforts, type ChatSettings } from '@aime/shared/threads';
import { ModelSelector } from '@/components/model-selector';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1 basis-40">
        <ModelSelector
          label={t('chat.model')}
          value={value.model}
          onValueChange={(model) => onChange({ ...value, model })}
          disabled={disabled}
          noneLabel={t('chat.defaultModel')}
          textOnly
        />
      </div>
      <Select
        value={value.reasoningEffort}
        onValueChange={(reasoningEffort: ChatSettings['reasoningEffort']) =>
          onChange({ ...value, reasoningEffort })
        }
        disabled={disabled}
      >
        <SelectTrigger aria-label={t('chat.reasoning')} className="max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {reasoningEfforts.map((effort) => (
            <SelectItem key={effort} value={effort}>
              {t(`chat.reasoning.${effort}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
