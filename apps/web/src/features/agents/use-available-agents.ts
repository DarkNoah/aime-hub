import { useCallback, useEffect, useState } from 'react';
import type { AvailableAgents } from '@aime/shared/agents';
import { api } from '@/lib/rpc';

const listeners = new Set<() => void>();
export function invalidateAvailableAgents() {
  listeners.forEach((listener) => listener());
}

export function useAvailableAgents(projectId?: string, includeLocal = false) {
  const key = `${includeLocal}:${projectId ?? ''}`;
  const [result, setResult] = useState<{
    key: string;
    data: AvailableAgents;
  }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const refresh = () => {
      setLoading(true);
      setRevision((value) => value + 1);
    };
    listeners.add(refresh);
    window.addEventListener('focus', refresh);
    return () => {
      listeners.delete(refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api.agents
      .available(
        { query: { projectId, includeLocal } },
        { signal: controller.signal },
      )
      .then(
        (value) => {
          if (!controller.signal.aborted) {
            setResult({ key, data: value });
            setError(false);
            setLoading(false);
          }
        },
        () => {
          if (!controller.signal.aborted) {
            setError(true);
            setLoading(false);
          }
        },
      );
    return () => controller.abort();
  }, [revision, key, projectId, includeLocal]);
  return {
    data: result?.key === key ? result.data : undefined,
    loading: loading || (!error && result?.key !== key),
    error,
    refresh,
    retry: () => {
      setLoading(true);
      setRevision((value) => value + 1);
    },
  };
}
