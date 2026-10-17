import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { MoonshineSession } from '@/components/audio/moonshine-runtime';
import { SpeechInputController } from '@/components/audio/speech-input-controller';

export function useChatSpeechInput({
  setText,
  disabled,
}: {
  setText: (text: string) => void;
  disabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const toastId = useId();
  const language = i18n.resolvedLanguage?.startsWith('zh') ? 'zh' : 'en';
  // setText is scoped to the user/project/thread by useChatDraft. Changing the
  // draft destination disposes its recognizer before it can write to another chat.
  const controller = useMemo(
    () =>
      new SpeechInputController(
        language,
        (callbacks) => new MoonshineSession(callbacks),
        setText,
        (error) => {
          console.error('Speech input failed', error);
          const name = error instanceof Error ? error.name : '';
          toast.error(
            t(
              name === 'NotAllowedError' || name === 'SecurityError'
                ? 'chat.voiceInput.permissionDenied'
                : name === 'NotFoundError'
                  ? 'chat.voiceInput.noMicrophone'
                  : name === 'NotReadableError'
                    ? 'chat.voiceInput.microphoneBusy'
                    : 'chat.voiceInput.failed',
            ),
          );
        },
      ),
    [language, setText, t],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useEffect(
    () => () => {
      controller.cancel();
      toast.dismiss(toastId);
    },
    [controller, toastId],
  );
  useEffect(() => {
    if (state.status === 'idle' || state.status === 'listening') {
      toast.dismiss(toastId);
      return;
    }
    const percent = state.progress?.total
      ? Math.min(
          100,
          Math.floor((state.progress.loaded / state.progress.total) * 100),
        )
      : null;
    const label = t(
      state.status === 'loading'
        ? percent === 100
          ? 'chat.voiceInput.initializing'
          : 'chat.voiceInput.downloading'
        : state.status === 'starting'
          ? 'chat.voiceInput.starting'
          : 'chat.voiceInput.finishing',
    );
    toast.loading(label, {
      id: toastId,
      duration: Infinity,
      closeButton: false,
      action: { label: t('chat.voiceInput.stop'), onClick: controller.cancel },
      description:
        state.status === 'loading' ? (
          <div className="mt-2 w-full min-w-48 space-y-2">
            <Progress
              value={percent}
              aria-label={label}
              className={cn(
                'h-1',
                percent === null &&
                  '[&>[data-slot=progress-indicator]]:translate-x-0! [&>[data-slot=progress-indicator]]:animate-pulse',
              )}
            />
            <div className="flex justify-between gap-3 text-xs tabular-nums">
              <span>
                {state.progress
                  ? `${(state.progress.loaded / 1024 / 1024).toFixed(1)} MB`
                  : t('chat.voiceInput.downloadHint')}
              </span>
              {percent !== null && <span>{percent}%</span>}
            </div>
          </div>
        ) : undefined,
    });
  }, [controller, state, t, toastId]);
  useEffect(() => {
    if (disabled) controller.cancel();
  }, [controller, disabled]);

  return {
    ...state,
    active: state.status !== 'idle',
    cancel: controller.cancel,
    stop: () => controller.stop(),
    toggle: (draft: string) => {
      if (controller.getSnapshot().status !== 'idle') {
        void controller.stop();
        return;
      }
      if (disabled) return;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        toast.error(t('chat.voiceInput.unsupported'));
        return;
      }
      if (
        !window.crossOriginIsolated ||
        typeof SharedArrayBuffer === 'undefined'
      ) {
        toast.error(t('chat.voiceInput.isolationRequired'));
        return;
      }
      void controller.start(draft);
    },
  };
}
