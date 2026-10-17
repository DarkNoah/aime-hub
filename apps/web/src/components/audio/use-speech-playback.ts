import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { speechEventSchema } from '@aime/shared/audio';
import { SpeechPlayer, type SpeechPlaybackState } from './speech-player';

export function useSpeechPlayback(threadId: string) {
  const { t } = useTranslation();
  const [state, setState] = useState<SpeechPlaybackState>(null);
  const player = useRef<SpeechPlayer | null>(null);
  const reportError = useRef(() =>
    toast.error(t('chat.speech.playbackFailed')),
  );
  useEffect(() => {
    reportError.current = () => toast.error(t('chat.speech.playbackFailed'));
  }, [t]);
  useEffect(() => {
    const current = new SpeechPlayer(
      (next) =>
        setState((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        ),
      () => reportError.current(),
    );
    player.current = current;
    return () => {
      current.dispose();
      player.current = null;
    };
  }, [threadId]);
  const receive = useCallback((event: Event) => {
    try {
      const parsed = speechEventSchema.safeParse(
        JSON.parse((event as MessageEvent).data),
      );
      if (parsed.success) player.current?.receive(parsed.data);
    } catch {
      /* Ignore malformed events; they must never reach the decoder. */
    }
  }, []);
  const stop = useCallback(() => player.current?.stop(), []);
  const unlock = useCallback(() => player.current?.unlock(), []);
  const readSpectrum = useCallback((levels: Float32Array) => {
    if (player.current) player.current.readSpectrum(levels);
    else levels.fill(0);
  }, []);
  return { state, receive, stop, unlock, readSpectrum };
}
