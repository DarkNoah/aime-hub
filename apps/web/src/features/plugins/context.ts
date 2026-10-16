import { createContext, useContext } from 'react';
import type {
  PluginStatus,
  PluginConfigSaveResult,
  PluginConfiguration,
} from '@app/plugin-sdk';

export const PluginContext = createContext<{
  plugins: PluginStatus[];
  loading: boolean;
  error: boolean;
  refresh(): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  saveConfig(
    id: string,
    configuration: PluginConfiguration,
  ): Promise<PluginConfigSaveResult>;
} | null>(null);
export function usePlugins() {
  const context = useContext(PluginContext);
  if (!context) throw new Error('PluginProvider is required');
  return context;
}
