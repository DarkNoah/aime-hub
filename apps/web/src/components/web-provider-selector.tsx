import { useTranslation } from 'react-i18next';
import {
  providerSupportsWebTool,
  type ProviderSummary,
} from '@aime/shared/providers';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const noneValue = '__default__';

export function WebProviderSelector({
  id,
  tool,
  providers,
  value,
  onValueChange,
  noneLabel,
  disabled,
  invalid,
  describedBy,
}: {
  id: string;
  tool: 'web_search' | 'web_fetch';
  providers: ProviderSummary[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  noneLabel: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const { t } = useTranslation();
  const choices = providers.filter((provider) =>
    providerSupportsWebTool(provider.type, tool),
  );
  const missing = value && !choices.some((provider) => provider.id === value);
  return (
    <Select
      value={value ?? noneValue}
      onValueChange={(next) => onValueChange(next === noneValue ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        className="w-full min-w-0 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"
        aria-invalid={invalid}
        aria-describedby={describedBy}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        className="max-w-(--radix-select-trigger-width)"
      >
        <SelectItem value={noneValue}>{noneLabel}</SelectItem>
        {missing && (
          <SelectItem value={value} disabled>
            {t('defaults.providerUnavailable')}
          </SelectItem>
        )}
        {choices.map((provider) => (
          <SelectItem
            key={provider.id}
            value={provider.id}
            disabled={!provider.enabled || !provider.hasApiKey}
          >
            <span className="truncate">
              {provider.name}
              {!provider.enabled || !provider.hasApiKey
                ? ` · ${t('tools.unavailable')}`
                : ''}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
