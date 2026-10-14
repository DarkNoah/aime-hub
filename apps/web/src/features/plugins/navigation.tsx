import { Link } from '@tanstack/react-router';
import { Puzzle } from 'lucide-react';
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
    .flatMap((plugin) =>
      plugin.pages
        .filter(
          (page) => page.navigation && (page.access === 'admin') === admin,
        )
        .map((page) => (
          <Link
            key={`${plugin.id}/${page.path}`}
            to={admin ? '/admin/p/$pluginId/$' : '/p/$pluginId/$'}
            params={{ pluginId: plugin.id, _splat: page.path }}
            activeOptions={{ exact: true }}
            className="sidebar-link flex h-9 items-center gap-3 rounded-lg px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            activeProps={{ className: 'bg-accent font-semibold text-primary' }}
            inactiveProps={{
              className:
                'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
            }}
            onClick={onNavigate}
          >
            <Puzzle className="size-4" />
            {page.title}
          </Link>
        )),
    );
}
