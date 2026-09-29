import { useEffect, useState } from 'react';
import { providerErrorKey, providerRequest } from './providers-api';
import type { ErrorKey } from '@/i18n/config';

export function useProviderResource<T>(path: string, revision: number) {
  const key = JSON.stringify([path, revision]);
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error?: ErrorKey;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void providerRequest<T>(path, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setResult({ key, error: providerErrorKey(error) });
      },
    );
    return () => controller.abort();
  }, [path, key]);
  return {
    loading: result?.key !== key,
    data: result?.key === key ? result.data : undefined,
    error: result?.key === key ? result.error : undefined,
  };
}
