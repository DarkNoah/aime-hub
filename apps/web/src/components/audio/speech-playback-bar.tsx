import { Play, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { SpeechPlaybackState } from './speech-player';
import { SpeechWaveform } from './speech-waveform';

export function SpeechPlaybackBar({
  state,
  readSpectrum,
  onResume,
  onStop,
}: {
  state: SpeechPlaybackState;
  readSpectrum: (levels: Float32Array) => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  if (!state) return null;
  return (
    <div
      className="@container mb-2 flex min-w-0 items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2"
      role="region"
      aria-label={t('chat.speech.playback')}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <Badge
            variant="secondary"
            className="shrink-0 text-[10px]"
            role="status"
          >
            {t(
              state.status === 'blocked'
                ? 'chat.speech.blocked'
                : state.status === 'playing'
                  ? 'chat.speech.playing'
                  : 'chat.speech.generating',
            )}
          </Badge>
          {state.queued > 0 && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {t('chat.speech.queuedCount', { count: state.queued })}
            </span>
          )}
          <SpeechWaveform
            playing={state.status === 'playing'}
            readSpectrum={readSpectrum}
            className="ml-auto min-w-16 max-w-36 flex-1"
          />
        </div>
        <p
          className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground"
          title={state.text}
        >
          {state.text}
        </p>
      </div>
      {state.status === 'blocked' && (
        <Button
          variant="outline"
          size="sm"
          className="size-8 shrink-0 @min-[360px]:w-auto"
          onClick={onResume}
          title={t('chat.speech.resume')}
          aria-label={t('chat.speech.resume')}
        >
          <Play className="size-3.5" aria-hidden="true" />
          <span className="hidden @min-[360px]:inline">
            {t('chat.speech.resume')}
          </span>
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={onStop}
        title={t('chat.speech.stop')}
        aria-label={t('chat.speech.stop')}
      >
        <Square className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
