import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { PluginStatus } from '@app/plugin-sdk';
import { pluginRequest } from '@app/plugin-sdk/web';
import { invalidateAvailableAgents } from '@/features/agents/use-available-agents';
import { PluginContext } from './context';

export function PluginProvider({ children }: { children: ReactNode }) {
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const revision = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    return fetch('/api/plugins', {
      credentials: 'same-origin',
      signal: request.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('PLUGIN_LIST_FAILED');
        return response.json() as Promise<PluginStatus[]>;
      })
      .then((data) => {
        if (revision === generation.current && !request.signal.aborted) {
          setPlugins(data);
          setError(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (revision === generation.current && !request.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      });
  }, []);
  useEffect(() => {
    void refresh();
    const check = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const interval = window.setInterval(check, 15000);
    window.addEventListener('focus', check);
    return () => {
      controller.current?.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', check);
    };
  }, [refresh]);
  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    const value = await pluginRequest<PluginStatus>(id, '/enabled', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    ++generation.current;
    controller.current?.abort();
    setPlugins((current) =>
      current.map((item) => (item.id === id ? value : item)),
    );
    invalidateAvailableAgents();
  }, []);
  const value = useMemo(
    () => ({ plugins, loading, error, refresh, setEnabled }),
    [plugins, loading, error, refresh, setEnabled],
  );
  return (
    <PluginContext.Provider value={value}>{children}</PluginContext.Provider>
  );
}
