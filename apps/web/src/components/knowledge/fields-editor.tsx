import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type { KnowledgeField } from '@aime/shared/knowledge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
export function FieldsEditor({
  fields,
  onChange,
  disabled,
}: {
  fields: KnowledgeField[];
  onChange: (fields: KnowledgeField[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">
        {t('knowledge.fields')}
      </legend>
      <p className="text-xs text-muted-foreground">
        {t('knowledge.fieldsHint')}
      </p>
      {fields.map((f, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={t('knowledge.fieldName')}
            placeholder="department"
            className="min-w-28 flex-1"
            maxLength={40}
            value={f.name}
            onChange={(e) =>
              onChange(
                fields.map((v, n) =>
                  n === i ? { ...v, name: e.target.value } : v,
                ),
              )
            }
          />
          <Input
            aria-label={t('knowledge.fieldLabel')}
            placeholder={t('knowledge.fieldLabel')}
            className="min-w-28 flex-1"
            maxLength={80}
            value={f.label ?? ''}
            onChange={(e) =>
              onChange(
                fields.map((v, n) =>
                  n === i ? { ...v, label: e.target.value } : v,
                ),
              )
            }
          />
          <Select
            value={f.type}
            disabled={disabled}
            onValueChange={(type: KnowledgeField['type']) =>
              onChange(fields.map((v, n) => (n === i ? { ...v, type } : v)))
            }
          >
            <SelectTrigger
              aria-label={t('knowledge.fieldType')}
              className="w-28"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                ['text', 'number', 'boolean', 'date', 'json', 'blob'] as const
              ).map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('knowledge.removeField')}
            onClick={() => onChange(fields.filter((_, n) => n !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
      {!disabled && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...fields, { name: '', type: 'text' }])}
        >
          <Plus />
          {t('knowledge.addField')}
        </Button>
      )}
    </fieldset>
  );
}
