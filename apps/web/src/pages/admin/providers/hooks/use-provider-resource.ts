import { useEffect, useState, useEffectEvent } from 'react';
import { providerErrorKey } from '../api';
import type { ErrorKey } from '@/i18n/config';

export function useProviderResource<T>(
  resourceKey: string,
  revision: number,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const key = JSON.stringify([resourceKey, revision]);
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error?: ErrorKey;
  }>();
  const request = useEffectEvent(load);
  useEffect(() => {
    const controller = new AbortController();
    void request(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setResult({ key, error: providerErrorKey(error) });
      },
    );
    return () => controller.abort();
  }, [key]);
  return {
    loading: result?.key !== key,
    data: result?.key === key ? result.data : undefined,
    error: result?.key === key ? result.error : undefined,
    updateData: (update: (data: T) => T) => {
      setResult((current) =>
        current?.key === key && current.data !== undefined
          ? { ...current, data: update(current.data) }
          : current,
      );
    },
  };
}
