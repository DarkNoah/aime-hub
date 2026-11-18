import {
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  LoaderCircle,
  PanelRightClose,
  RotateCw,
  Square,
  PanelsTopLeft,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { BrowserAction } from '@aime/shared/browser';
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from '@/components/ai-elements/web-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { BrowserScreencast } from './screencast';
import { BrowserPanelOpenContext } from './layout-context';
import { browserErrorKey, getBrowserResource } from './resource';
import { useAuthSession } from '@/features/auth/session-context';

export default function BrowserPanel({
  threadId,
  onClose,
}: {
  threadId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const onOpen = useContext(BrowserPanelOpenContext);
  useEffect(() => {
    onOpen?.();
  }, [onOpen, threadId]);
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-card"
      aria-label={t('browser.title')}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Globe2 className="size-4 text-primary" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {t('browser.title')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <PanelRightClose className="size-4" />
        </Button>
      </header>
      {threadId ? (
        <BrowserContent key={threadId} threadId={threadId} />
      ) : (
        <p className="m-auto p-6 text-center text-sm text-muted-foreground">
          {t('browser.startChat')}
        </p>
      )}
    </section>
  );
}

function BrowserContent({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const sessionId = useAuthSession().data?.session.id ?? '';
  const switchId = useId();
  const resource = useMemo(
    () => getBrowserResource(threadId, sessionId),
    [threadId, sessionId],
  );
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  const [interactive, setInteractive] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [closing, setClosing] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const composingAddress = useRef(false);
  const lastError = useRef(0);
  const ready = state.status === 'ready' && state.connection === 'connected';
  const canNavigate =
    state.connection === 'connected' && interactive && !pending && !closing;
  const canControl = ready && canNavigate;
  function report(error: unknown) {
    if (Date.now() - lastError.current < 2000) return;
    lastError.current = Date.now();
    toast.error(t(browserErrorKey(error)));
  }
  async function action(value: BrowserAction) {
    if (value.kind === 'close') setClosing(true);
    else setPending((count) => count + 1);
    try {
      await resource.action(value);
      if (value.kind === 'close') toast.success(t('browser.closedSuccess'));
      return true;
    } catch (error) {
      report(error);
      return false;
    } finally {
      if (value.kind === 'close') setClosing(false);
      else setPending((count) => count - 1);
    }
  }
  async function navigate() {
    if (!canNavigate) return;
    const value = (draft ?? state.url).trim();
    let url: URL;
    try {
      if (!value) throw new Error();
      url = new URL(
        /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`,
      );
    } catch {
      toast.error(t('browser.invalidUrl'));
      return;
    }
    setDraft(url.href);
    setNavigating(true);
    try {
      if (await action({ kind: 'navigate', url: url.href })) setDraft(null);
    } finally {
      setNavigating(false);
    }
  }
  const statusLabel =
    state.connection === 'connected'
      ? state.busy
        ? 'browser.agentWorking'
        : (`browser.status.${state.status}` as const)
      : (`browser.${state.connection}` as const);
  return (
    <WebPreview className="min-h-0 rounded-none border-0">
      <WebPreviewNavigation className="shrink-0 gap-0.5">
        <WebPreviewNavigationButton
          tooltip={t('browser.back')}
          aria-label={t('browser.back')}
          disabled={!canControl}
          onClick={() => void action({ kind: 'back' })}
        >
          <ArrowLeft className="size-3.5" />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          tooltip={t('browser.forward')}
          aria-label={t('browser.forward')}
          disabled={!canControl}
          onClick={() => void action({ kind: 'forward' })}
        >
          <ArrowRight className="size-3.5" />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton
          tooltip={t('browser.reload')}
          aria-label={t('browser.reload')}
          disabled={!canControl}
          onClick={() => void action({ kind: 'reload' })}
        >
          <RotateCw className="size-3.5" />
        </WebPreviewNavigationButton>
        <form
          className="relative min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!composingAddress.current) void navigate();
          }}
        >
          <WebPreviewUrl
            value={draft ?? state.url}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              composingAddress.current =
                event.nativeEvent.isComposing || event.keyCode === 229;
            }}
            onKeyUp={() => {
              composingAddress.current = false;
            }}
            onBlur={() => {
              composingAddress.current = false;
            }}
            readOnly={!canNavigate}
            inputMode="url"
            enterKeyHint="go"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-busy={navigating}
            aria-label={t('browser.address')}
            placeholder={t('browser.address')}
            className="h-8 w-full text-xs aria-busy:pr-8"
          />
          {navigating && (
            <span
              role="status"
              className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground"
            >
              <LoaderCircle
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
              <span className="sr-only">{t('browser.opening')}</span>
            </span>
          )}
        </form>
        {state.tabs.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1 px-2"
                aria-label={t('browser.tabs')}
                title={t('browser.tabs')}
                disabled={!canControl}
              >
                <PanelsTopLeft className="size-4" />
                <span className="text-xs">{state.tabs.length}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <ScrollArea
                className="max-h-64"
                viewportProps={{ style: { maxHeight: 256 } }}
              >
                {state.tabs.map((tab, index) => (
                  <DropdownMenuItem
                    key={index}
                    onSelect={() => void action({ kind: 'tab', index })}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {tab.title || tab.url}
                    </span>
                    {index === state.activeTabIndex && (
                      <span className="size-1.5 rounded-full bg-primary" />
                    )}
                  </DropdownMenuItem>
                ))}
              </ScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </WebPreviewNavigation>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Badge
          variant={state.status === 'error' ? 'destructive' : 'secondary'}
          className="font-normal"
        >
          {t(statusLabel)}
        </Badge>
        <label
          htmlFor={switchId}
          className="ml-auto flex items-center gap-2 text-xs text-muted-foreground"
        >
          {t('browser.allowInput')}
          <Switch
            id={switchId}
            size="sm"
            checked={interactive}
            disabled={state.connection !== 'connected' || !!pending || closing}
            onCheckedChange={setInteractive}
          />
        </label>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={
            closing ||
            state.connection === 'forbidden' ||
            (state.status !== 'ready' && state.status !== 'error')
          }
          title={t('browser.closeBrowser')}
          aria-label={t('browser.closeBrowser')}
          onClick={() => void action({ kind: 'close' })}
        >
          <Square className="size-3" />
        </Button>
      </div>
      <BrowserScreencast
        resource={resource}
        interactive={canControl}
        fitViewport={ready && interactive && !closing}
        onError={report}
      />
      <p className="shrink-0 border-t px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <span className="mb-1 block">{t('browser.sharedProfileHint')}</span>
        {t(
          !interactive
            ? 'browser.watchHint'
            : state.busy
              ? 'browser.busyHint'
              : 'browser.keyboardHint',
        )}
      </p>
    </WebPreview>
  );
}
