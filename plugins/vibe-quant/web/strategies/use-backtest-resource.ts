import { useEffect, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import { errorText } from './format';

/** Discard obsolete responses when switching runs, pages, or selected trades. */
export function useBacktestResource<T>(
  pluginId: string,
  path: string | null,
  revision = '',
) {
  const [retry, setRetry] = useState(0);
  const key = `${pluginId}:${path}:${revision}:${retry}`;
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!path) return;
    const abort = new AbortController();
    pluginRequest<T>(pluginId, path, { signal: abort.signal })
      .then((data) => {
        if (!abort.signal.aborted) setState({ key, data });
      })
      .catch((error) => {
        if (!abort.signal.aborted) setState({ key, error: errorText(error) });
      });
    return () => abort.abort();
  }, [pluginId, path, key]);
  return {
    data: state?.key === key ? state.data : undefined,
    previousData: state?.data,
    error: state?.key === key ? state.error : undefined,
    reload: () => setRetry((value) => value + 1),
  };
}
