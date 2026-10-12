import { useEffect, useState } from 'react';
import type { AvailableAgents } from '@aime/shared/agents';
import { api } from '@/lib/rpc';

const listeners = new Set<() => void>();
export function invalidateAvailableAgents() {
  listeners.forEach((listener) => listener());
}

export function useAvailableAgents() {
  const [data, setData] = useState<AvailableAgents>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
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
    void api.agents.available(undefined, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) {
          setData(value);
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
  }, [revision]);
  return {
    data,
    loading,
    error,
    retry: () => {
      setLoading(true);
      setRevision((value) => value + 1);
    },
  };
}
