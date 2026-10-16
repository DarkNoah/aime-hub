import { useTranslation } from 'react-i18next';
import {
  isPluginConfigFieldVisible,
  type PluginConfigField,
  type PluginConfigIssue,
} from '@app/plugin-sdk';
import { PasswordInput } from '@/components/password-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function PluginConfigFields({
  pluginId,
  fields,
  values,
  issues,
  disabled,
  onChange,
  activeGroup,
  onGroupChange,
}: {
  pluginId: string;
  fields: readonly PluginConfigField[];
  values: Readonly<Record<string, string | boolean>>;
  issues: readonly PluginConfigIssue[];
  disabled: boolean;
  onChange(key: string, value: string | boolean): void;
  activeGroup: string;
  onGroupChange(group: string): void;
}) {
  const { t } = useTranslation();
  const groups = new Map<string, PluginConfigField[]>();
  for (const field of fields) {
    // Keep invalid fields reachable even if their controlling field was changed.
    if (
      !isPluginConfigFieldVisible(field, values) &&
      !issues.some((issue) => issue.field === field.key)
    )
      continue;
    const group = field.group ?? '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(field);
  }
  const renderFields = (items: PluginConfigField[]) =>
    items.map((field) => {
      const id = `plugin-config-${pluginId}-${field.key}`;
      const invalid = issues.some((issue) => issue.field === field.key);
      const required =
        field.required && isPluginConfigFieldVisible(field, values);
      const props = {
        id,
        disabled,
        'aria-invalid': invalid,
        'aria-required': required,
        'aria-describedby': `${id}-hint`,
      };
      const setValue = (value: string | boolean) => onChange(field.key, value);
      const stringValue = String(values[field.key] ?? '');
      return (
        <div key={field.key} className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={id}>
              {field.label}
              {required && (
                <span className="text-destructive" aria-hidden="true">
                  {' '}
                  *
                </span>
              )}
            </Label>
            {field.type === 'boolean' && (
              <Switch
                {...props}
                checked={values[field.key] === true}
                onCheckedChange={setValue}
              />
            )}
          </div>
          {field.type === 'password' ? (
            <PasswordInput
              {...props}
              value={stringValue}
              onChange={(event) => setValue(event.target.value)}
              placeholder={field.placeholder}
              maxLength={16384}
              autoComplete="new-password"
              spellCheck={false}
            />
          ) : field.type === 'select' ? (
            <Select
              value={stringValue}
              onValueChange={setValue}
              disabled={disabled}
            >
              <SelectTrigger {...props} className="w-full">
                <SelectValue placeholder={field.placeholder} />
              </SelectTrigger>
              <SelectContent>
                {field.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : field.type === 'text' ? (
            field.multiline ? (
              <Textarea
                {...props}
                value={stringValue}
                onChange={(event) => setValue(event.target.value)}
                placeholder={field.placeholder}
                maxLength={16384}
                rows={4}
              />
            ) : (
              <Input
                {...props}
                value={stringValue}
                onChange={(event) => setValue(event.target.value)}
                placeholder={field.placeholder}
                maxLength={16384}
              />
            )
          ) : field.type === 'number' ? (
            <Input
              {...props}
              type="number"
              value={stringValue}
              min={field.min}
              max={field.max}
              step={field.integer ? 1 : 'any'}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : null}
          <div id={`${id}-hint`} className="space-y-1 text-xs">
            {field.description && (
              <p className="text-muted-foreground">{field.description}</p>
            )}
            {invalid && (
              <p className="text-destructive">
                {t('plugins.configInvalidField')}
              </p>
            )}
          </div>
        </div>
      );
    });
  if (!fields.some((field) => field.group))
    return (
      <div className="space-y-4">
        {renderFields([...groups.values()].flat())}
      </div>
    );
  const selected = groups.has(activeGroup)
    ? activeGroup
    : (groups.keys().next().value ?? '');
  return (
    <Tabs
      value={`group:${selected}`}
      onValueChange={(value) => onGroupChange(value.slice(6))}
      className="gap-5"
    >
      <TabsList
        className="sticky top-0 z-10 flex w-full flex-wrap group-data-[orientation=horizontal]/tabs:h-auto"
        aria-label={t('plugins.configGroups')}
      >
        {[...groups].map(([group, items]) => {
          const count = items.filter((field) =>
            issues.some((issue) => issue.field === field.key),
          ).length;
          return (
            <TabsTrigger
              key={group}
              value={`group:${group}`}
              disabled={disabled}
              className="min-h-8 px-2 text-xs sm:text-sm"
            >
              {group || t('plugins.configGeneral')}
              {count > 0 && (
                <Badge
                  variant="destructive"
                  className="size-4 justify-center p-0 text-[10px]"
                >
                  {count}
                </Badge>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
      {[...groups].map(([group, items]) => (
        <TabsContent
          key={group}
          value={`group:${group}`}
          className="min-h-48 space-y-4"
        >
          {renderFields(items)}
        </TabsContent>
      ))}
    </Tabs>
  );
}
