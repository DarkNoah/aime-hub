import type { ErrorKey } from '@/i18n/config';
import { useTranslation } from 'react-i18next';
import { useState, type ReactNode } from 'react';
import { SessionContext } from '@/lib/session-context';
import { AlertCircle, LoaderCircle, RotateCw } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { authErrorKey } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Brand } from '@/components/brand';

export function SessionProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const session = authClient.useSession();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<ErrorKey | null>(null);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      await session.refetch();
    } catch (error) {
      setRetryError(authErrorKey(error, 'errors.sessionCheck'));
    } finally {
      setRetrying(false);
    }
  }

  if (session.isPending || session.error || retryError) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
        <Brand />
        {session.isPending ? (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <LoaderCircle className="size-4 animate-spin" />
            {t('session.checking')}
          </p>
        ) : (
          <div className="max-w-sm space-y-4 text-center">
            <p role="alert" className="text-sm leading-6 text-destructive">
              <AlertCircle className="mx-auto mb-3 size-6" />
              {t(
                retryError ??
                  authErrorKey(session.error, 'errors.sessionCheck'),
              )}
            </p>
            <Button
              variant="outline"
              onClick={() => void retry()}
              disabled={retrying || session.isRefetching}
            >
              <RotateCw
                className={
                  retrying || session.isRefetching ? 'animate-spin' : ''
                }
              />
              {t('session.retry')}
            </Button>
          </div>
        )}
      </main>
    );
  }

  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}
