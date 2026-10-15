import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KnowledgeField, KnowledgeMetadata } from '@aime/shared/knowledge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function MetadataEditor({
  fields,
  initial = {},
  disabled,
  onChange,
  filtering = false,
}: {
  fields: KnowledgeField[];
  initial?: KnowledgeMetadata;
  disabled?: boolean;
  onChange: (value: KnowledgeMetadata | undefined) => void;
  filtering?: boolean;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.name,
        initial[f.name] == null
          ? ''
          : f.type === 'json'
            ? JSON.stringify(initial[f.name])
            : String(initial[f.name]),
      ]),
    ),
  );
  const [invalid, setInvalid] = useState(false);
  function change(name: string, value: string) {
    const next = { ...draft, [name]: value };
    setDraft(next);
    try {
      const parsed: KnowledgeMetadata = {};
      for (const field of fields) {
        const raw = next[field.name]?.trim() ?? '';
        if (!raw) {
          if (!filtering) parsed[field.name] = null;
          continue;
        }
        parsed[field.name] =
          field.type === 'number'
            ? Number(raw)
            : field.type === 'boolean'
              ? raw === 'true'
              : field.type === 'json'
                ? JSON.parse(raw)
                : raw;
        if (field.type === 'number' && !Number.isFinite(parsed[field.name]))
          throw new Error();
        if (field.type === 'date' && !Number.isFinite(Date.parse(raw)))
          throw new Error();
      }
      setInvalid(false);
      onChange(parsed);
    } catch {
      setInvalid(true);
      onChange(undefined);
    }
  }
  if (!fields.length) return null;
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">
        {t(filtering ? 'knowledge.metadataFilter' : 'knowledge.metadata')}
      </legend>
      {fields.map((field) => (
        <div key={field.name} className="space-y-1.5">
          <Label htmlFor={`${formId}-${field.name}`}>
            {field.label || field.name}{' '}
            <span className="text-xs text-muted-foreground">{field.type}</span>
          </Label>
          {field.type === 'boolean' ? (
            <Select
              value={draft[field.name] || 'unset'}
              onValueChange={(v) => change(field.name, v === 'unset' ? '' : v)}
              disabled={disabled}
            >
              <SelectTrigger id={`${formId}-${field.name}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unset">
                  {t('knowledge.fieldUnset')}
                </SelectItem>
                <SelectItem value="true">true</SelectItem>
                <SelectItem value="false">false</SelectItem>
              </SelectContent>
            </Select>
          ) : field.type === 'json' ? (
            <Textarea
              id={`${formId}-${field.name}`}
              value={draft[field.name] ?? ''}
              onChange={(e) => change(field.name, e.target.value)}
              placeholder='{"key":"value"}'
            />
          ) : (
            <Input
              id={`${formId}-${field.name}`}
              type={field.type === 'number' ? 'number' : 'text'}
              step="any"
              value={draft[field.name] ?? ''}
              placeholder={
                field.type === 'date'
                  ? '2026-10-15'
                  : field.type === 'blob'
                    ? 'Base64'
                    : ''
              }
              onChange={(e) => change(field.name, e.target.value)}
            />
          )}
        </div>
      ))}
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          {t('knowledge.errorMetadata')}
        </p>
      )}
    </fieldset>
  );
}
