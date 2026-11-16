import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ScrollArea,
} from '@app/plugin-ui';
import { ChevronDown, Filter } from 'lucide-react';
import type { MarketPositionsPage } from '../../market-positions';

export function MarketStrategyFilter({
  strategies,
  selectedIds,
  onChange,
}: {
  strategies: MarketPositionsPage['strategies'];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const selected = new Set(selectedIds);
  return (
    <div className="shrink-0 px-3 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 text-xs"
            aria-label="按策略筛选"
            disabled={!strategies.length && !selectedIds.length}
          >
            <Filter className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">
              {selected.size === 0
                ? '全部策略'
                : selected.size === 1
                  ? (strategies.find((item) => selected.has(item.id))?.name ??
                    '已选策略')
                  : '已选策略'}
            </span>
            {selected.size > 0 && (
              <Badge variant="secondary" className="px-1.5 tabular-nums">
                {selected.size}
              </Badge>
            )}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64 max-w-[calc(100vw-2rem)] overflow-hidden"
        >
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            按策略筛选 · 可多选
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onChange([])}>
            全部策略
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <ScrollArea viewportProps={{ className: 'max-h-[min(60dvh,360px)]' }}>
            {strategies.map((strategy) => (
              <DropdownMenuCheckboxItem
                key={strategy.id}
                checked={selected.has(strategy.id)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...selectedIds, strategy.id]
                      : selectedIds.filter((id) => id !== strategy.id),
                  )
                }
                onSelect={(event) => event.preventDefault()}
              >
                <span className="min-w-0 break-words">{strategy.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </ScrollArea>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
