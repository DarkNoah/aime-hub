import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { cn } from '@/lib/utils';

type ChatConversationProps = {
  children: ReactNode;
  composer: ReactNode;
  contentClassName?: string;
};

export function ChatConversation(props: ChatConversationProps) {
  return (
    <Conversation className="min-h-0" initial="instant" resize="instant">
      <ChatConversationLayout {...props} />
    </Conversation>
  );
}

function ChatConversationLayout({
  children,
  composer,
  contentClassName,
}: ChatConversationProps) {
  const { t } = useTranslation();
  const { isAtBottom } = useStickToBottomContext();
  const layoutRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const layout = layoutRef.current;
    const footer = composerRef.current;
    if (!layout || !footer) return;
    let previousHeight = -1;
    const updateHeight = () => {
      const height = Math.ceil(footer.getBoundingClientRect().height);
      if (height === previousHeight) return;
      previousHeight = height;
      layout.style.setProperty('--chat-composer-height', `${height}px`);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={layoutRef}
      className="relative h-full [--chat-composer-height:0px]"
    >
      <ConversationContent
        data-chat-messages
        className={cn('gap-6 pt-6', contentClassName)}
        style={{ paddingBottom: 'calc(var(--chat-composer-height) + 1.5rem)' }}
      >
        {children}
      </ConversationContent>
      <div
        aria-hidden="true"
        data-chat-scroll-blur
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 h-[calc(var(--chat-composer-height)+2rem)] backdrop-blur-sm transition-opacity duration-200 [mask-image:linear-gradient(to_bottom,transparent,black_2rem)] motion-reduce:transition-none',
          isAtBottom ? 'opacity-0' : 'opacity-100',
        )}
      />
      <div
        ref={composerRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10"
      >
        {composer}
      </div>
      <ConversationScrollButton
        aria-label={t('chat.toLatest')}
        className="z-20 bottom-[calc(var(--chat-composer-height)+1rem)]"
      />
    </div>
  );
}
