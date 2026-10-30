import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelsTopLeft, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import {
  INTELLIGENT_UI_CHANNEL,
  intelligentUiInputSchema,
  parseIntelligentUiResponse,
} from '@aime/shared/intelligent-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useTheme } from '@/components/theme/context';
import type { ToolInteractionProps } from '../chat-tool-interaction';
import { useToolResponse } from './use-tool-response';
import {
  buildIntelligentUiDocument,
  getIntelligentUiLinkUrl,
} from './intelligent-ui-document';

type NonBlockingUi = {
  input: { html: string; title?: string | null; tips?: string | null };
  onSend: (
    id: string,
    data: ReturnType<typeof parseIntelligentUiResponse>,
  ) => Promise<void>;
};

export function IntelligentUI(
  props: ToolInteractionProps & { nonBlocking?: NonBlockingUi },
) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { interaction, tool, nonBlocking } = props;
  const input = intelligentUiInputSchema.safeParse(
    nonBlocking?.input ?? interaction?.input ?? tool?.input,
  ).data;
  const { response, pending, unavailable, error, submit } =
    useToolResponse(props);
  const [frameError, setFrameError] = useState('');
  const [messagePending, setMessagePending] = useState(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const [height, setHeight] = useState(180);
  const [token] = useState(() => nanoid());
  const frame = useRef<HTMLIFrameElement>(null);
  const sending = useRef(false);
  const accepted = useRef(false);
  const done = !!response || tool?.state === 'output-available';
  const failed =
    tool?.state === 'output-error' || tool?.state === 'output-denied';
  const streaming = tool?.state === 'input-streaming';
  const waits = !nonBlocking && input?.waitForResponse === true;
  const enabled = nonBlocking
    ? !props.disabled && !messagePending
    : waits && !unavailable && !done && !failed && !streaming;
  const locked =
    !!failed ||
    (nonBlocking ? !!props.disabled || messagePending : waits && !enabled);
  const result = response?.action === 'resume' ? response.data : tool?.output;
  const cancelled =
    !!result &&
    typeof result === 'object' &&
    'cancelled' in result &&
    result.cancelled === true;
  const isNonBlocking = !!nonBlocking;
  const html = streaming ? '' : (input?.html ?? '');
  // Status and theme changes must not recreate the document or erase form values.
  const srcDoc = useMemo(
    () =>
      buildIntelligentUiDocument(
        html,
        token,
        isNonBlocking ? 'message' : 'resume',
      ),
    [html, token, isNonBlocking],
  );
  const send = (type: string, payload: Record<string, unknown> = {}) =>
    frame.current?.contentWindow?.postMessage(
      { channel: INTELLIGENT_UI_CHANNEL, token, type, ...payload },
      '*',
    );
  const syncState = useEffectEvent(() => {
    const style = getComputedStyle(document.documentElement);
    const colors = Object.fromEntries(
      [
        'background',
        'foreground',
        'muted',
        'muted-foreground',
        'primary',
        'primary-foreground',
        'border',
      ].map((name) => [
        '--' + name,
        style.getPropertyValue('--' + name).trim(),
      ]),
    );
    send('state', { enabled, locked, theme: resolvedTheme, colors });
  });
  const receive = useEffectEvent(async (event: MessageEvent) => {
    const data = event.data;
    if (
      event.source !== frame.current?.contentWindow ||
      !data ||
      data.channel !== INTELLIGENT_UI_CHANNEL ||
      data.token !== token
    )
      return;
    if (data.type === 'ready') return syncState();
    if (data.type === 'open-link') {
      const url = getIntelligentUiLinkUrl(data.url);
      if (
        url &&
        !locked &&
        !streaming &&
        document.activeElement === frame.current &&
        navigator.userActivation?.isActive
      )
        window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (
      data.type === 'resize' &&
      typeof data.height === 'number' &&
      Number.isFinite(data.height)
    ) {
      setHeight(Math.max(80, Math.ceil(data.height)));
      return;
    }
    if (data.type === 'error') {
      setFrameError(
        typeof data.message === 'string'
          ? data.message.slice(0, 500)
          : t('chat.intelligentUi.invalidData'),
      );
      return;
    }
    if (data.type !== (nonBlocking ? 'message' : 'resume')) return;
    if (
      nonBlocking &&
      (document.activeElement !== frame.current ||
        !navigator.userActivation?.isActive)
    )
      return;
    if (!enabled || sending.current || (!nonBlocking && accepted.current)) {
      send('ack');
      return;
    }
    sending.current = true;
    try {
      const value = parseIntelligentUiResponse(data.data);
      setFrameError('');
      if (nonBlocking) {
        const signature = JSON.stringify(value);
        if (request.current?.signature !== signature)
          request.current = { signature, id: nanoid() };
        setMessagePending(true);
        await nonBlocking.onSend(request.current.id, value);
        request.current = null;
        toast.success(t('groupChat.uiSent'));
      } else {
        accepted.current = await submit({ action: 'resume', data: value });
      }
    } catch {
      setFrameError(
        t(nonBlocking ? 'groupChat.failed' : 'chat.intelligentUi.invalidData'),
      );
    } finally {
      sending.current = false;
      setMessagePending(false);
      send('ack');
    }
  });
  useEffect(() => {
    const listener = (event: MessageEvent) => void receive(event);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
  useEffect(() => {
    syncState();
  }, [enabled, locked, resolvedTheme, srcDoc]);

  const status = failed
    ? 'chat.toolInteraction.failed'
    : streaming
      ? 'chat.intelligentUi.preparing'
      : cancelled
        ? 'chat.intelligentUi.skipped'
        : pending || messagePending
          ? 'chat.toolInteraction.submitting'
          : nonBlocking
            ? 'groupChat.uiReady'
            : waits
              ? done
                ? 'chat.toolInteraction.completed'
                : 'chat.toolInteraction.waiting'
              : 'chat.intelligentUi.display';
  return (
    <section
      className="my-3 min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground"
      aria-label={input?.title || 'IntelligentUI'}
    >
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <PanelsTopLeft
              className="size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <span className="truncate" title={input?.title || 'IntelligentUI'}>
              {input?.title || 'IntelligentUI'}
            </span>
          </div>
          {input?.tips && (
            <p className="whitespace-pre-wrap break-words pl-6 text-xs leading-relaxed text-muted-foreground">
              {input.tips}
            </p>
          )}
        </div>
        <Badge
          variant={failed ? 'destructive' : 'secondary'}
          className="shrink-0"
          role="status"
        >
          {t(status)}
        </Badge>
      </div>
      {streaming ? (
        <div
          className="space-y-3 p-4"
          aria-label={t('chat.intelligentUi.preparing')}
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : html ? (
        <iframe
          ref={frame}
          title={input?.title || 'IntelligentUI'}
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'"
          className="block w-full border-0"
          style={{ height }}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {t('chat.intelligentUi.missingHtml')}
        </p>
      )}
      {(error || frameError || failed) && (
        <p role="alert" className="border-t px-4 py-3 text-sm text-destructive">
          {error
            ? t(error)
            : frameError || tool?.errorText || t('chat.toolInteraction.failed')}
        </p>
      )}
      {waits && !done && !failed && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <p className="text-xs leading-5 text-muted-foreground">
            {t(
              interaction
                ? 'chat.intelligentUi.hint'
                : 'chat.toolInteraction.unavailable',
            )}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={!enabled}
            onClick={() =>
              void submit({ action: 'resume', data: { cancelled: true } })
            }
          >
            <X aria-hidden="true" />
            {t('chat.intelligentUi.skip')}
          </Button>
        </div>
      )}
      {waits && done && !cancelled && result !== undefined && (
        <details className="border-t px-4 py-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {t('chat.intelligentUi.result')}
          </summary>
          <ScrollArea
            className="mt-2 rounded-md bg-muted [&_[data-slot=scroll-area-scrollbar]]:hidden"
            viewportProps={{ className: 'max-h-40' }}
          >
            <pre className="whitespace-pre-wrap break-all p-3">
              {JSON.stringify(result, null, 2)}
            </pre>
          </ScrollArea>
        </details>
      )}
    </section>
  );
}
