import type {
  PluginPageProps,
  PluginSidebarProps,
  PluginWeb,
} from '@app/plugin-sdk/web';
import { ScrollArea } from '@app/plugin-ui';
import { Notebook } from './notebook';
import { NotebookOverview, NotebookOverviewPage } from './overview';

function NotebookPage({ pluginId }: PluginPageProps) {
  return <Notebook pluginId={pluginId} />;
}
function NotebookSidebar({ pluginId }: PluginSidebarProps) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-4">
        <Notebook pluginId={pluginId} compact />
      </div>
    </ScrollArea>
  );
}
export default {
  pages: { '': NotebookPage, overview: NotebookOverviewPage },
  rightSidebar: { notes: NotebookSidebar, overview: NotebookOverview },
} satisfies PluginWeb;
