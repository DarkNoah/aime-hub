import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { chatErrorKey } from './api';

export function ChatContinueButton({
  disabled,
  onContinue,
}: {
  disabled?: boolean;
  onContinue: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const pending = useRef(false);
  const [continuing, setContinuing] = useState(false);

  async function continueRun() {
    if (disabled || pending.current) return;
    pending.current = true;
    setContinuing(true);
    try {
      await onContinue();
    } catch (cause) {
      toast.error(t(chatErrorKey(cause)));
    } finally {
      pending.current = false;
      setContinuing(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="self-start"
      disabled={disabled || continuing}
      onClick={() => void continueRun()}
    >
      {continuing ? (
        <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <Play aria-hidden="true" />
      )}
      {t(continuing ? 'chat.continuing' : 'chat.continue')}
    </Button>
  );
}
