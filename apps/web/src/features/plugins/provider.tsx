import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  PluginStatus,
  PluginConfiguration,
  PluginConfigSaveResult,
} from '@app/plugin-sdk';
import { pluginRequest, PluginRequestError } from '@app/plugin-sdk/web';
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
  const update = useCallback((value: PluginStatus) => {
    ++generation.current;
    controller.current?.abort();
    setPlugins((current) =>
      current.map((item) => (item.id === value.id ? value : item)),
    );
    invalidateAvailableAgents();
  }, []);
  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        update(
          await pluginRequest<PluginStatus>(id, '/enabled', {
            method: 'PUT',
            body: JSON.stringify({ enabled }),
          }),
        );
      } catch (error) {
        if (error instanceof PluginRequestError && error.plugin?.id === id)
          update(error.plugin);
        throw error;
      }
    },
    [update],
  );
  const saveConfig = useCallback(
    async (id: string, configuration: PluginConfiguration) => {
      try {
        const result = await pluginRequest<PluginConfigSaveResult>(
          id,
          '/config',
          {
            method: 'PUT',
            body: JSON.stringify(configuration),
          },
        );
        update(result.plugin);
        return result;
      } catch (error) {
        if (error instanceof PluginRequestError && error.plugin?.id === id)
          update(error.plugin);
        throw error;
      }
    },
    [update],
  );
  const value = useMemo(
    () => ({ plugins, loading, error, refresh, setEnabled, saveConfig }),
    [plugins, loading, error, refresh, setEnabled, saveConfig],
  );
  return (
    <PluginContext.Provider value={value}>{children}</PluginContext.Provider>
  );
}
