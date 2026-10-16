import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { Puzzle, RefreshCw, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePlugins } from '@/features/plugins/context';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PluginConfigDialog } from './components/config-dialog';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';

export function AdminPluginsPage() {
  const { t } = useTranslation();
  const { plugins, loading, error, refresh, setEnabled } = usePlugins();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const changing = useRef(new Set<string>());
  const [configId, setConfigId] = useState<string | null>(null);
  const configTrigger = useRef<HTMLButtonElement | null>(null);
  const configuredPlugin = plugins.find((plugin) => plugin.id === configId);
  async function toggle(id: string, enabled: boolean) {
    if (changing.current.has(id)) return;
    changing.current.add(id);
    setPending(new Set(changing.current));
    try {
      await setEnabled(id, enabled);
      toast.success(t('plugins.saved'));
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      toast.error(
        code === 'PLUGIN_HAS_DEPENDENTS'
          ? t('plugins.hasDependents')
          : code === 'PLUGIN_DEPENDENCY_DISABLED'
            ? t('plugins.dependencyDisabled')
            : code === 'PLUGIN_ENABLE_FAILED'
              ? t('plugins.enableFailed')
              : code === 'PLUGIN_DISABLE_FAILED'
                ? t('plugins.disableFailed')
                : code === 'PLUGIN_CONFIG_INVALID'
                  ? t('plugins.configInvalid')
                  : t('plugins.saveFailed'),
      );
    } finally {
      changing.current.delete(id);
      setPending(new Set(changing.current));
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title={t('plugins.title')}
        description={t('plugins.description')}
        actions={
          <Button variant="outline" onClick={() => void refresh()}>
            <RefreshCw />
            {t('plugins.refresh')}
          </Button>
        }
      />
      {loading ? (
        <LoadingState />
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">
          {t('plugins.loadFailed')}
        </p>
      ) : (
        <ItemGroup className="gap-3">
          {plugins.map((plugin) => (
            <Item
              key={plugin.id}
              variant="outline"
              className="flex-wrap rounded-xl bg-card"
            >
              <ItemMedia variant="icon">
                <Puzzle />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {plugin.name}
                  <Badge variant={plugin.enabled ? 'default' : 'secondary'}>
                    {!plugin.ready
                      ? t('plugins.needsMigration')
                      : plugin.enabled
                        ? t('plugins.enabled')
                        : t('plugins.disabled')}
                  </Badge>
                  <Badge variant="outline">v{plugin.version}</Badge>
                </ItemTitle>
                <ItemDescription>{plugin.description}</ItemDescription>
                {plugin.reason && (
                  <p className="text-sm text-muted-foreground">
                    {plugin.reason}
                  </p>
                )}
              </ItemContent>
              <ItemActions>
                {plugin.configFields.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!plugin.ready || pending.has(plugin.id)}
                    onClick={(event) => {
                      configTrigger.current = event.currentTarget;
                      setConfigId(plugin.id);
                    }}
                  >
                    <Settings2 />
                    {t('plugins.configure')}
                  </Button>
                )}
                {plugin.enabled &&
                  plugin.pages
                    .filter((p) => p.navigation)
                    .map((page) => (
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        key={page.path}
                      >
                        <Link
                          to={
                            page.access === 'admin'
                              ? '/admin/p/$pluginId/$'
                              : '/p/$pluginId/$'
                          }
                          params={{ pluginId: plugin.id, _splat: page.path }}
                        >
                          {page.title}
                        </Link>
                      </Button>
                    ))}
                <Switch
                  checked={plugin.desiredEnabled}
                  disabled={!plugin.ready || pending.has(plugin.id)}
                  aria-label={`${t('plugins.toggle')} ${plugin.name}`}
                  onCheckedChange={(enabled) => void toggle(plugin.id, enabled)}
                />
              </ItemActions>
            </Item>
          ))}
          {!plugins.length && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t('plugins.empty')}
            </p>
          )}
        </ItemGroup>
      )}
      {configuredPlugin && (
        <PluginConfigDialog
          key={configuredPlugin.id}
          plugin={configuredPlugin}
          onClose={() => setConfigId(null)}
          restoreFocus={() => configTrigger.current?.focus()}
        />
      )}
    </div>
  );
}
