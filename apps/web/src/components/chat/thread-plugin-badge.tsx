import { useContext } from 'react';
import { Badge } from '@/components/ui/badge';
import { PluginContext } from '@/features/plugins/context';
import { cn } from '@/lib/utils';

export function ThreadPluginBadge({
  plugin,
  className,
}: {
  plugin?: string;
  className?: string;
}) {
  const context = useContext(PluginContext);
  if (!plugin) return null;
  const name =
    context?.plugins.find((item) => item.id === plugin)?.name ?? plugin;
  return (
    <Badge
      variant="outline"
      className={cn('max-w-28 shrink-0', className)}
      title={name}
    >
      <span className="truncate">{name}</span>
    </Badge>
  );
}
