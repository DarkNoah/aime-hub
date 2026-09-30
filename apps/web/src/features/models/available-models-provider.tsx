import { useEffect, useState, type ReactNode } from 'react';
import { useAuthSession } from '@/features/auth/session-context';
import { AvailableModelsContext } from './use-available-models';
import { createModelsResource, onModelsInvalidated } from './resource';

function ModelsCache({
  children,
  authenticated,
}: {
  children: ReactNode;
  authenticated: boolean;
}) {
  const [resource] = useState(createModelsResource);
  useEffect(() => {
    if (!authenticated) return;
    void resource.refresh();
    const invalidate = () => {
      void resource.refresh(true);
    };
    const refresh = () => {
      void resource.refresh();
    };
    const unsubscribe = onModelsInvalidated(invalidate);
    window.addEventListener('focus', refresh);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refresh);
    };
  }, [authenticated, resource]);
  return (
    <AvailableModelsContext.Provider value={resource}>
      {children}
    </AvailableModelsContext.Provider>
  );
}

export function AvailableModelsProvider({ children }: { children: ReactNode }) {
  const { data } = useAuthSession();
  const sessionId = data?.session.id;
  return (
    <ModelsCache key={sessionId ?? 'anonymous'} authenticated={!!sessionId}>
      {children}
    </ModelsCache>
  );
}
