import { lazy, Suspense } from 'react';
import { PluginBoundary } from '@/features/plugins/boundary';
import { useParams } from '@tanstack/react-router';
import type { PluginPageProps } from '@app/plugin-sdk/web';
import { usePlugins } from '@/features/plugins/context';
import { pluginLoaders, pluginManifests } from '@/features/plugins/generated';
import { useAuthSession } from '@/features/auth/session-context';
import { isAdmin } from '@/features/auth/client';
import { LoadingState } from '@/components/loading-state';
import { Button } from '@/components/ui/button';

const pages = pluginManifests
  .flatMap((plugin) =>
    plugin.pages.map((page) => ({
      pluginId: plugin.id,
      ...page,
      Component: lazy(async () => {
        const module = await pluginLoaders[plugin.id]();
        const Page = module.default.pages[page.path];
        if (!Page)
          throw new Error(`Missing plugin page: ${plugin.id}/${page.path}`);
        return { default: Page };
      }),
    })),
  )
  .sort((a, b) => a.path.split(':').length - b.path.split(':').length);

export function PluginPage({ admin = false }: { admin?: boolean }) {
  const { pluginId, _splat = '' } = useParams({ strict: false });
  const { plugins, loading, error, refresh } = usePlugins();
  const { data } = useAuthSession();
  if (loading) return <LoadingState />;
  if (error)
    return (
      <div role="alert" className="space-y-4">
        <p>无法获取插件状态。</p>
        <Button variant="outline" onClick={() => void refresh()}>
          重试
        </Button>
      </div>
    );
  const path = _splat.replace(/\/$/, '');
  const match = findPage(pluginId, path, admin);
  const page = match?.page;
  if (
    !page ||
    !plugins.some((p) => p.id === pluginId && p.enabled) ||
    (admin && !isAdmin(data?.user.role))
  )
    return <p role="status">此插件已停用，或页面不可用。</p>;
  return (
    <PluginBoundary
      key={`${pluginId}/${page.path}`}
      message="插件页面加载失败，请刷新页面重试。"
    >
      <Suspense fallback={<LoadingState />}>
        <page.Component
          pluginId={pluginId!}
          path={path}
          params={match!.params}
        />
      </Suspense>
    </PluginBoundary>
  );
}

function findPage(
  pluginId: string | undefined,
  path: string,
  admin: boolean,
):
  | { page: (typeof pages)[number]; params: PluginPageProps['params'] }
  | undefined {
  for (const page of pages) {
    if (page.pluginId !== pluginId || (page.access === 'admin') !== admin)
      continue;
    const segments = page.path.split('/');
    const actual = path.split('/');
    if (segments.length !== actual.length) continue;
    const params: Record<string, string> = {};
    const matches = segments.every((part, i) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = actual[i];
        return !!actual[i];
      }
      return part === actual[i];
    });
    if (matches) return { page, params };
  }
}
