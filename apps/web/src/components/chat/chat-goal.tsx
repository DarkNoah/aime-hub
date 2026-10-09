import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function ChatGoal({
  disabled,
  onClose,
}: {
  disabled: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      className="gap-1.5 border-primary/20 bg-primary/5 text-primary"
      data-chat-goal
    >
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={disabled}
        onClick={onClose}
        aria-label={t('chat.goal.close')}
        title={t('chat.goal.close')}
        className="-ml-1 size-5 rounded-full text-current hover:bg-primary/10 hover:text-primary focus-visible:ring-inset"
      >
        <X className="size-3" aria-hidden="true" />
      </Button>
      <span>{t('chat.goal.title')}</span>
    </Badge>
  );
}
