import { lazy } from 'react';
import { ChartNoAxesCombined, List, NotebookPen, Puzzle } from 'lucide-react';
import { useAuthSession } from '@/features/auth/session-context';
import { isAdmin } from '@/features/auth/client';
import { usePlugins } from './context';
import { pluginLoaders, pluginManifests } from './generated';

const icons = {
  puzzle: Puzzle,
  notebook: NotebookPen,
  list: List,
  chart: ChartNoAxesCombined,
};
const entries = pluginManifests.flatMap((plugin) =>
  plugin.rightSidebar.map((panel) => ({
    ...panel,
    pluginId: plugin.id,
    view: `plugin:${plugin.id}:${panel.id}` as const,
    Icon: icons[panel.icon],
    Component: lazy(async () => {
      const module = await pluginLoaders[plugin.id]();
      const Panel = module.default.rightSidebar?.[panel.id];
      if (!Panel)
        throw new Error(`Missing plugin sidebar: ${plugin.id}/${panel.id}`);
      return { default: Panel };
    }),
  })),
);

export function usePluginRightSidebar() {
  const { plugins, error } = usePlugins();
  const { data } = useAuthSession();
  // Fail closed when activation cannot be refreshed; the API also checks every request.
  return entries.filter(
    (entry) =>
      !error &&
      plugins.some(
        (plugin) => plugin.id === entry.pluginId && plugin.enabled,
      ) &&
      (entry.access === 'session' || isAdmin(data?.user.role)),
  );
}
