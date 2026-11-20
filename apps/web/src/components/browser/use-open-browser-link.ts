import { useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SessionContext } from '@/features/auth/session-context';
import { browserErrorKey, getBrowserResource } from './resource';

export function useOpenBrowserLink(
  threadId: string | undefined,
  showPanel: () => void,
) {
  const { t } = useTranslation();
  const sessionId = useContext(SessionContext)?.data?.session.id;
  const open = useCallback(
    (url: string) => {
      if (!threadId || !sessionId) return;
      showPanel();
      void getBrowserResource(threadId, sessionId)
        .action({ kind: 'navigate', url })
        .catch((error: unknown) => toast.error(t(browserErrorKey(error))));
    },
    [threadId, sessionId, showPanel, t],
  );
  return threadId && sessionId ? open : null;
}
