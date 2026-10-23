import { Pencil } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useImageEdit, type ImageEditSource } from './image-edit-context';

export function ImageEditButton({
  className,
  variant = 'ghost',
  size = 'icon-sm',
  ...image
}: ImageEditSource &
  Pick<ComponentProps<typeof Button>, 'className' | 'variant' | 'size'>) {
  const { t } = useTranslation();
  const editor = useImageEdit();
  if (!editor?.available) return null;
  const label = t('imagePreview.edit', { name: image.name });
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn('shrink-0 text-muted-foreground shadow-none', className)}
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      onClick={(event) => {
        event.stopPropagation();
        editor.open(image);
      }}
    >
      <Pencil className="size-3.5" aria-hidden="true" />
    </Button>
  );
}
