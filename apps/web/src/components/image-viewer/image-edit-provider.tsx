import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ImageEditContext, type ImageEditReceiver } from './image-edit-context';

/** Scope image edits to the composer in this conversation. */
export function ImageEditProvider({ children }: { children: ReactNode }) {
  const receiver = useRef<ImageEditReceiver | null>(null);
  const [available, setAvailable] = useState(false);
  const open = useCallback<ImageEditReceiver>(
    (image) => receiver.current?.(image),
    [],
  );
  const register = useCallback((next: ImageEditReceiver) => {
    receiver.current = next;
    setAvailable(true);
    return () => {
      if (receiver.current === next) {
        receiver.current = null;
        setAvailable(false);
      }
    };
  }, []);
  const value = useMemo(
    () => ({ open, register, available }),
    [open, register, available],
  );
  return (
    <ImageEditContext.Provider value={value}>
      {children}
    </ImageEditContext.Provider>
  );
}
