import { useTranslation } from 'react-i18next';
import {
  providerConfigFieldName,
  providerFieldText,
  type ProviderConfigField,
} from '@aime/shared/provider-configuration';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function ProviderConfigurationFields({
  fields,
  metadata,
  disabled,
}: {
  fields: readonly ProviderConfigField[];
  metadata?: Record<string, unknown>;
  disabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  if (!fields.length) return null;
  return (
    <fieldset className="space-y-4 rounded-lg border p-4" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">
        {t('providers.additionalSettings')}
      </legend>
      {fields.map((field) => {
        const id = `provider-config-${field.key}`;
        const name = providerConfigFieldName(field.key);
        const value = metadata?.[field.key] ?? field.defaultValue;
        const label = providerFieldText(field.label, i18n.language);
        const description = providerFieldText(field.description, i18n.language);
        const common = {
          id,
          name,
          disabled,
          required: field.required,
          'aria-describedby': description ? `${id}-hint` : undefined,
        };
        return (
          <div key={field.key} className="space-y-2">
            <div
              className={
                field.type === 'switch'
                  ? 'flex items-center justify-between gap-3'
                  : 'space-y-2'
              }
            >
              <Label htmlFor={id}>
                {label}
                {field.required && (
                  <span aria-hidden="true" className="text-destructive">
                    {' '}
                    *
                  </span>
                )}
              </Label>
              {field.type === 'switch' ? (
                <Switch
                  {...common}
                  required={false}
                  defaultChecked={value === true}
                />
              ) : field.type === 'select' ? (
                <Select
                  name={name}
                  disabled={disabled}
                  required={field.required}
                  defaultValue={typeof value === 'string' ? value : ''}
                >
                  <SelectTrigger
                    id={id}
                    className="w-full"
                    aria-describedby={common['aria-describedby']}
                  >
                    <SelectValue placeholder={t('providers.selectSetting')} />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {providerFieldText(option.label, i18n.language)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === 'textarea' ? (
                <Textarea
                  {...common}
                  defaultValue={typeof value === 'string' ? value : ''}
                  placeholder={providerFieldText(
                    field.placeholder,
                    i18n.language,
                  )}
                  rows={3}
                />
              ) : field.type === 'number' ? (
                <Input
                  {...common}
                  type="number"
                  step={field.integer ? 1 : 'any'}
                  min={field.min}
                  max={field.max}
                  defaultValue={typeof value === 'number' ? value : ''}
                  placeholder={providerFieldText(
                    field.placeholder,
                    i18n.language,
                  )}
                />
              ) : (
                <Input
                  {...common}
                  type="text"
                  autoComplete="off"
                  pattern={field.pattern}
                  defaultValue={typeof value === 'string' ? value : ''}
                  placeholder={providerFieldText(
                    field.placeholder,
                    i18n.language,
                  )}
                />
              )}
            </div>
            {description && (
              <p
                id={`${id}-hint`}
                className="text-xs leading-5 text-muted-foreground"
              >
                {description}
              </p>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
