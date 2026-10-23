import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Globe2, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { BrowserSummary } from '@aime/shared/browser';
import { api, apiErrorCode } from '@/lib/rpc';
import {
  FloatingPreviewStack,
  type FloatingPreviewStackHandle,
} from '@/components/floating-preview-stack';
import { browserWorkspaceState } from '@/components/chat/workspace-navigation';
import { BrowserScreencast } from './screencast';
import { browserErrorKey, getBrowserResource } from './resource';
import { RunningBrowsersContext } from './layout-context';
import { useAuthSession } from '@/features/auth/session-context';

/** The server owns the catalog, so refresh and route changes preserve running browsers. */
export function BrowserDock({
  userId,
  ref,
  children,
}: {
  userId: string;
  ref?: Ref<FloatingPreviewStackHandle>;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const sessionId = useAuthSession().data?.session.id ?? '';
  const navigate = useNavigate();
  const [browsers, setBrowsers] = useState<BrowserSummary[]>([]);
  const [closing, setClosing] = useState<string | null>(null);
  const [visible, setVisible] = useState(!document.hidden);
  const revision = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (controller.signal.aborted) return;
      if (!document.hidden) {
        try {
          const version = revision.current;
          const next = await api.threads.browser.list(undefined, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted && version === revision.current)
            setBrowsers((previous) =>
              JSON.stringify(previous) === JSON.stringify(next)
                ? previous
                : next,
            );
        } catch (error) {
          if (
            !controller.signal.aborted &&
            ['UNAUTHORIZED', 'FORBIDDEN'].includes(apiErrorCode(error) ?? '')
          )
            setBrowsers([]);
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
    }
    const visibility = () => {
      setVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', visibility);
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [userId]);

  function open(browser: BrowserSummary) {
    if (browser.projectId)
      void navigate({
        to: '/projects/$projectId/threads/$threadId',
        params: { projectId: browser.projectId, threadId: browser.threadId },
        state: browserWorkspaceState(browser.threadId),
      });
    else
      void navigate({
        to: '/threads/$threadId',
        params: { threadId: browser.threadId },
        state: browserWorkspaceState(browser.threadId),
      });
  }
  async function close(threadId: string) {
    setClosing(threadId);
    try {
      await getBrowserResource(threadId, sessionId).action({ kind: 'close' });
      revision.current += 1;
      setBrowsers([]);
      toast.success(t('browser.closedSuccess'));
    } catch (error) {
      toast.error(t(browserErrorKey(error)));
    } finally {
      setClosing(null);
    }
  }
  return (
    <RunningBrowsersContext.Provider value={browsers}>
      {children}
      <FloatingPreviewStack
        ref={ref}
        minimizeOnOpen
        storageKey={`browser-preview-stack:v1:${userId}`}
        label={t('browser.runningBrowsers')}
        openLabel={t('browser.openThread')}
        closeLabel={t('browser.stopBrowser')}
        closeIcon={<Square className="size-3.5" />}
        moveLabel={t('browser.movePreview')}
        minimizeLabel={t('browser.minimize')}
        expandLabel={t('browser.expand')}
        switchLabel={t('browser.switchBrowser')}
        items={browsers.map((browser) => ({
          id: browser.threadId,
          title: browser.title || t('chat.new'),
          subtitle: browser.url,
          icon: <Globe2 className="size-4" />,
          status: (
            <>
              {t(
                browser.busy ? 'browser.agentWorking' : 'browser.status.ready',
              )}
              {browser.tabCount > 1 &&
                ` · ${t('browser.tabCount', { count: browser.tabCount })}`}
            </>
          ),
          closing: closing !== null,
          onOpen: () => open(browser),
          onClose: () => void close(browser.threadId),
        }))}
        renderPreview={(item) =>
          visible ? (
            <BrowserScreencast
              key={item.id}
              resource={getBrowserResource(item.id, sessionId)}
              className="h-full"
            />
          ) : null
        }
      />
    </RunningBrowsersContext.Provider>
  );
}
