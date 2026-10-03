import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, LoaderCircle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { chatErrorKey } from './api';

export function ChatErrorCard({
  error,
  onRetry,
  disabled,
}: {
  error: string;
  onRetry: () => Promise<void>;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const pending = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const errorKey = chatErrorKey(error);
  const message =
    errorKey === 'chat.errors.failed' && error !== 'CHAT_FAILED'
      ? error
      : t(errorKey);

  async function retry() {
    if (pending.current || disabled) return;
    pending.current = true;
    setRetrying(true);
    try {
      await onRetry();
    } catch (cause) {
      toast.error(t(chatErrorKey(cause)));
    } finally {
      pending.current = false;
      setRetrying(false);
    }
  }

  return (
    <Card
      role="alert"
      className="min-w-0 gap-0 border-destructive/20 bg-destructive/5 py-4 shadow-none"
    >
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center gap-2">
          <AlertCircle className="size-4 text-destructive" aria-hidden="true" />
          <Badge variant="destructive">{t('chat.errorTitle')}</Badge>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
          {message}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || retrying}
          onClick={() => void retry()}
        >
          {retrying ? (
            <LoaderCircle
              className="size-3.5 motion-safe:animate-spin"
              aria-hidden="true"
            />
          ) : (
            <RotateCcw className="size-3.5" aria-hidden="true" />
          )}
          {t(retrying ? 'chat.retrying' : 'chat.retry')}
        </Button>
      </CardContent>
    </Card>
  );
}
