import { Link } from '@tanstack/react-router';
import { ChevronRight, FileText, Puzzle } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { usePlugins } from './context';

export function PluginNavigation({
  admin = false,
  onNavigate,
}: {
  admin?: boolean;
  onNavigate?: () => void;
}) {
  const { plugins } = usePlugins();
  return plugins
    .filter((p) => p.enabled)
    .map((plugin) => {
      const pages = plugin.pages.filter(
        (page) => page.navigation && (page.access === 'admin') === admin,
      );
      if (!pages.length) return null;

      return (
        <Collapsible key={plugin.id} defaultOpen>
          <CollapsibleTrigger
            title={plugin.name}
            className="group/plugin flex h-10 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left text-sm outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Puzzle aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium">
              {plugin.name}
            </span>
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/plugin:rotate-90 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1 mb-2 ml-4 space-y-1">
              {pages.map((page) => (
                <Link
                  key={page.path}
                  to={admin ? '/admin/p/$pluginId/$' : '/p/$pluginId/$'}
                  params={{ pluginId: plugin.id, _splat: page.path }}
                  activeOptions={{ exact: true }}
                  title={page.title}
                  className="sidebar-link flex h-9 min-w-0 items-center gap-3 rounded-lg px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  activeProps={{
                    className: 'bg-accent font-semibold text-primary',
                  }}
                  inactiveProps={{
                    className:
                      'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                  }}
                  onClick={onNavigate}
                >
                  <FileText aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate">{page.title}</span>
                </Link>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      );
    });
}
