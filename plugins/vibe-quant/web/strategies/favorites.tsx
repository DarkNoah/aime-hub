import { useEffect, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import { Button } from '@app/plugin-ui';
import { Star } from 'lucide-react';
import { toast } from 'sonner';
import type { StrategySummary } from '../../strategy-types';
import { errorText } from './format';

export function useStrategyFavorites(pluginId: string) {
  const [ids, setIds] = useState<Set<string>>();
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setIds(undefined);
    void pluginRequest<string[]>(pluginId, '/strategies/favorites', {
      signal: abort.signal,
    })
      .then((favorites) => {
        if (!abort.signal.aborted) setIds(new Set(favorites));
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          toast.error('无法读取策略收藏', {
            description: errorText(cause),
            action: { label: '重试', onClick: () => setRetry((n) => n + 1) },
          });
      });
    return () => abort.abort();
  }, [pluginId, retry]);

  async function toggle(id: string) {
    if (!ids || pending.has(id)) return;
    const favorite = !ids.has(id);
    setPending((old) => new Set(old).add(id));
    try {
      await pluginRequest(pluginId, `/strategies/${id}/favorite`, {
        method: 'PUT',
        body: JSON.stringify({ favorite }),
      });
      setIds((old) => {
        const next = new Set(old);
        if (favorite) next.add(id);
        else next.delete(id);
        return next;
      });
      toast.success(favorite ? '已收藏策略' : '已取消收藏');
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setPending((old) => {
        const next = new Set(old);
        next.delete(id);
        return next;
      });
    }
  }
  return { ids, pending, toggle };
}

export function StrategyFavoriteButton({
  item,
  favorites,
  withLabel = false,
}: {
  item: StrategySummary;
  favorites: ReturnType<typeof useStrategyFavorites>;
  withLabel?: boolean;
}) {
  const favorite = favorites.ids?.has(item.id);
  const action = favorite ? '取消收藏' : '收藏';
  return (
    <Button
      type="button"
      variant="ghost"
      size={withLabel ? 'sm' : 'icon-sm'}
      className={withLabel ? 'shrink-0' : 'absolute right-1.5 top-1.5'}
      aria-label={`${action}策略「${item.name}」`}
      aria-pressed={favorite}
      title={action}
      disabled={!favorites.ids || favorites.pending.has(item.id)}
      onClick={() => void favorites.toggle(item.id)}
    >
      <Star
        aria-hidden="true"
        className={
          favorite
            ? 'size-4 fill-current text-amber-600 dark:text-amber-400'
            : 'size-4 text-muted-foreground'
        }
      />
      {withLabel && (favorite ? '已收藏' : '收藏')}
    </Button>
  );
}
