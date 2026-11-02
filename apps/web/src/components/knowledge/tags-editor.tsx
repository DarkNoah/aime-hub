import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import {
  knowledgeTagsSchema,
  type KnowledgeTags,
} from '@aime/shared/knowledge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export function TagsEditor({
  initial = {},
  onChange,
  disabled,
}: {
  initial?: KnowledgeTags;
  onChange: (tags: KnowledgeTags | undefined) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState(() =>
    Object.entries(initial).map(([dimension, values]) => ({
      dimension,
      values: values.join(', '),
    })),
  );
  const [invalid, setInvalid] = useState(false);
  function update(next: typeof rows) {
    setRows(next);
    const entries = next.filter((r) => r.dimension.trim() || r.values.trim());
    const result = knowledgeTagsSchema.safeParse(
      Object.fromEntries(
        entries.map((r) => [
          r.dimension.trim(),
          r.values
            .split(/[,，]/)
            .map((v) => v.trim())
            .filter(Boolean),
        ]),
      ),
    );
    const valid =
      result.success &&
      new Set(entries.map((r) => r.dimension.trim())).size === entries.length;
    setInvalid(!valid);
    onChange(valid ? result.data : undefined);
  }
  return (
    <fieldset disabled={disabled} className="space-y-2 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">
        {t('knowledge.tags')}
      </legend>
      <p className="text-xs text-muted-foreground">{t('knowledge.tagsHint')}</p>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={t('knowledge.tagDimension')}
            className="w-1/3"
            maxLength={64}
            placeholder={t('knowledge.tagDimension')}
            value={row.dimension}
            onChange={(e) =>
              update(
                rows.map((r, n) =>
                  n === i ? { ...r, dimension: e.target.value } : r,
                ),
              )
            }
          />
          <Input
            aria-label={t('knowledge.tagValues')}
            placeholder={t('knowledge.tagValues')}
            value={row.values}
            onChange={(e) =>
              update(
                rows.map((r, n) =>
                  n === i ? { ...r, values: e.target.value } : r,
                ),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('knowledge.removeTag')}
            onClick={() => update(rows.filter((_, n) => n !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => update([...rows, { dimension: '', values: '' }])}
      >
        <Plus />
        {t('knowledge.addTag')}
      </Button>
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          {t('knowledge.errorTags')}
        </p>
      )}
    </fieldset>
  );
}
export function TagsDisplay({ tags }: { tags: KnowledgeTags }) {
  return (
    <div className="flex flex-wrap gap-1">
      {Object.entries(tags).flatMap(([dimension, values]) =>
        values.map((value) => (
          <Badge variant="outline" key={`${dimension}:${value}`}>
            {dimension}: {value}
          </Badge>
        )),
      )}
    </div>
  );
}
