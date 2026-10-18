import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { chatErrorKey } from './api';

/** Anchor the first visible turn while a page is prepended above it. */
export function ChatHistoryLoader({
  hasEarlier,
  loading,
  loadEarlier,
  firstTurnId,
}: {
  hasEarlier: boolean;
  loading: boolean;
  loadEarlier: () => Promise<void>;
  firstTurnId?: string;
}) {
  const { t } = useTranslation();
  const { scrollRef, stopScroll, isAtBottom } = useStickToBottomContext();
  const sentinel = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const anchor = useRef<{
    element: Element;
    top: number;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useCallback(async () => {
    const viewport = scrollRef.current;
    if (!hasEarlier || busy.current || loading || !viewport) return;
    busy.current = true;
    setFailed(false);
    const top = viewport.getBoundingClientRect().top;
    const element = [...viewport.querySelectorAll('[data-chat-turn]')].find(
      (item) => item.getBoundingClientRect().bottom > top,
    );
    if (element)
      anchor.current = {
        element,
        top: element.getBoundingClientRect().top,
      };
    stopScroll();
    try {
      await loadEarlier();
    } catch (error) {
      anchor.current = null;
      setFailed(true);
      toast.error(t(chatErrorKey(error)));
    } finally {
      busy.current = false;
    }
  }, [hasEarlier, loading, loadEarlier, scrollRef, stopScroll, t]);

  useLayoutEffect(() => {
    const saved = anchor.current;
    const viewport = scrollRef.current;
    if (!saved || !viewport || loading) return;
    if (saved.element.isConnected) {
      // Native scroll anchoring can already have applied part of this correction.
      const delta = saved.element.getBoundingClientRect().top - saved.top;
      viewport.scrollTop += delta;
    }
    anchor.current = null;
  }, [firstTurnId, loading, scrollRef]);

  useEffect(() => {
    const element = sentinel.current;
    const viewport = scrollRef.current;
    if (!element || !viewport || !hasEarlier || failed || loading || isAtBottom)
      return;
    let frame = 0;
    // Wait for the initial stick-to-bottom positioning before observing the top.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting)
          frame = requestAnimationFrame(() => void request());
      },
      { root: viewport, rootMargin: '80px 0px 0px 0px' },
    );
    frame = requestAnimationFrame(() => observer.observe(element));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [hasEarlier, loading, failed, isAtBottom, request, scrollRef]);

  if (!hasEarlier) return null;
  return (
    <div
      ref={sentinel}
      className="flex min-h-8 justify-center"
      data-chat-history-loader
    >
      {loading ? (
        <LoaderCircle
          className="size-4 animate-spin text-muted-foreground"
          aria-label={t('chat.loading')}
        />
      ) : (
        <Button variant="ghost" size="sm" onClick={() => void request()}>
          {t(failed ? 'chat.retry' : 'chat.loadEarlier')}
        </Button>
      )}
    </div>
  );
}
