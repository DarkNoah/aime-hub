import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { defaultSystemSettings } from '@aime/shared/system-settings';
import { api } from '@/lib/rpc';
import { AppBrandingContext } from './app-branding-context';

export function AppBrandingProvider({ children }: { children: ReactNode }) {
  const [appName, setAppName] = useState(defaultSystemSettings.appName);
  const revision = useRef(0);
  const updateAppName = useCallback((value: string) => {
    revision.current += 1;
    setAppName(value);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const startedAt = revision.current;
    void api.systemSettings
      .branding(undefined, { signal: controller.signal })
      .then(
        (value) => {
          // A slow initial read must not overwrite a name just saved by the administrator.
          if (!controller.signal.aborted && startedAt === revision.current)
            setAppName(value.appName);
        },
        () => {},
      );
    return () => controller.abort();
  }, []);

  const value = useMemo(
    () => ({ appName, updateAppName }),
    [appName, updateAppName],
  );
  return (
    <AppBrandingContext.Provider value={value}>
      {children}
    </AppBrandingContext.Provider>
  );
}
