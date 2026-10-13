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
      className="size-7 shrink-0 justify-center gap-0 border-primary/20 bg-primary/5 p-0 text-primary @xl/chat:h-auto @xl/chat:w-auto @xl/chat:gap-1.5 @xl/chat:px-2 @xl/chat:py-0.5"
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
        className="size-6 rounded-full text-current hover:bg-primary/10 hover:text-primary focus-visible:ring-inset @xl/chat:-ml-1 @xl/chat:size-5"
      >
        <X className="size-3" aria-hidden="true" />
      </Button>
      <span className="hidden @xl/chat:inline">{t('chat.goal.title')}</span>
    </Badge>
  );
}
