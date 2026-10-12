import { useCallback, useMemo, useRef, type ReactNode } from 'react';

import { AssetAttachmentContext, type Receiver } from './context';

export function AssetAttachmentProvider({ children }: { children: ReactNode }) {
  const receiver = useRef<Receiver | null>(null);
  const add = useCallback<Receiver>(
    (assets) => receiver.current?.(assets) ?? false,
    [],
  );
  const register = useCallback((next: Receiver) => {
    receiver.current = next;
    return () => {
      if (receiver.current === next) receiver.current = null;
    };
  }, []);
  const value = useMemo(() => ({ add, register }), [add, register]);
  return (
    <AssetAttachmentContext.Provider value={value}>
      {children}
    </AssetAttachmentContext.Provider>
  );
}
