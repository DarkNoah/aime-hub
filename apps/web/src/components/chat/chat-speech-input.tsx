import { LoaderCircle, Mic, MicOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { SpeechInputState } from '@/components/audio/speech-input-controller';
import { cn } from '@/lib/utils';

export function ChatSpeechButton({
  status,
  disabled,
  onClick,
}: {
  status: SpeechInputState['status'];
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const active = status !== 'idle';
  const busy =
    status === 'loading' || status === 'starting' || status === 'stopping';
  const label = t(active ? 'chat.voiceInput.stop' : 'chat.voiceInput.start');
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className={cn(
        'size-7 @xl/chat:size-8',
        active &&
          'bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive',
      )}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={status === 'stopping' || (!active && disabled)}
      onClick={onClick}
    >
      {busy ? (
        <LoaderCircle className="animate-spin" />
      ) : active ? (
        <MicOff />
      ) : (
        <Mic />
      )}
    </Button>
  );
}
