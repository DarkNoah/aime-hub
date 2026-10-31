import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { toast } from 'sonner';
import { groupChatErrorKey } from '../api';

/** Resolve replies against the contiguous history window before scrolling. */
export function RoomMessageNavigation({
  targetId,
  firstMessageId,
  hasEarlier,
  loadingEarlier,
  loadEarlier,
  onComplete,
}: {
  targetId: string | null;
  firstMessageId?: string;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  onComplete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { scrollRef, stopScroll } = useStickToBottomContext();
  const activeTarget = useRef<string | null>(null);
  const highlight = useRef<{ element: HTMLElement; timer: number } | null>(
    null,
  );

  useEffect(() => {
    activeTarget.current = targetId;
    return () => {
      activeTarget.current = null;
    };
  }, [targetId]);

  useEffect(() => {
    if (!targetId || loadingEarlier) return;
    // Wait for both React's prepend and the history loader's anchor correction.
    const frame = requestAnimationFrame(() => {
      const viewport = scrollRef.current;
      if (!viewport) return;
      stopScroll();
      const element = viewport.querySelector<HTMLElement>(
        `[data-chat-turn="${CSS.escape(targetId)}"]`,
      );
      if (element) {
        viewport.scrollTo({
          top:
            viewport.scrollTop +
            element.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            Math.min(80, viewport.clientHeight / 4),
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
            .matches
            ? 'instant'
            : 'smooth',
        });
        element.focus({ preventScroll: true });
        if (highlight.current) {
          clearTimeout(highlight.current.timer);
          delete highlight.current.element.dataset.messageHighlight;
        }
        element.dataset.messageHighlight = '';
        highlight.current = {
          element,
          timer: window.setTimeout(() => {
            delete element.dataset.messageHighlight;
            highlight.current = null;
          }, 1800),
        };
        onComplete(targetId);
      } else if (hasEarlier) {
        void loadEarlier().catch((error: unknown) => {
          if (activeTarget.current !== targetId) return;
          toast.error(t(groupChatErrorKey(error)));
          onComplete(targetId);
        });
      } else {
        toast.error(t('groupChat.originalMessageUnavailable'));
        onComplete(targetId);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    targetId,
    firstMessageId,
    hasEarlier,
    loadingEarlier,
    loadEarlier,
    onComplete,
    scrollRef,
    stopScroll,
    t,
  ]);

  useEffect(
    () => () => {
      if (!highlight.current) return;
      clearTimeout(highlight.current.timer);
      delete highlight.current.element.dataset.messageHighlight;
    },
    [],
  );

  return null;
}
