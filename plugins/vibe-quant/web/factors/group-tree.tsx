import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@app/plugin-ui';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  LockKeyhole,
  MoreHorizontal,
  Plus,
} from 'lucide-react';
import type { FactorGroup, FactorSummary } from '../../factor-types';
import { UNGROUPED, groupDescendants } from '../../factor-groups';
import type { GroupAction } from './group-dialog';

export function FactorGroupTree({
  groups,
  items,
  query,
  selected,
  activeGroup,
  canEdit,
  onGroup,
  onSelect,
  onAction,
}: {
  groups: FactorGroup[];
  items: FactorSummary[];
  query: string;
  selected: string;
  activeGroup: string;
  canEdit: boolean;
  onGroup: (id: string) => void;
  onSelect: (id: string) => void;
  onAction: (action: GroupAction) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set([UNGROUPED]);
    let id = items.find((item) => item.id === selected)?.group_id;
    while (id && !open.has(id)) {
      open.add(id);
      id = groups.find((group) => group.id === id)?.parent_id ?? undefined;
    }
    return open;
  });
  const [limits, setLimits] = useState<Record<string, number>>({});
  const grouped = useMemo(() => {
    const map = new Map<string, FactorSummary[]>();
    for (const item of items) {
      const id = item.group_id ?? UNGROUPED;
      if (!map.has(id)) map.set(id, []);
      map.get(id)!.push(item);
    }
    return map;
  }, [items]);
  const search = query.trim().toLowerCase();
  const matches = (item: FactorSummary) =>
    `${item.name} ${item.description}`.toLowerCase().includes(search);
  const itemRow = (item: FactorSummary) => (
    <button
      key={item.id}
      type="button"
      aria-current={selected === item.id ? 'page' : undefined}
      onClick={() => onSelect(item.id)}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === item.id ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-accent/60'}`}
    >
      <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={item.name}>
        {item.name}
      </span>
      {!item.enabled && (
        <Badge variant="outline" className="px-1 text-[10px]">
          停用
        </Badge>
      )}
    </button>
  );
  function branch(parent: string | null, depth = 0): React.ReactNode {
    return groups
      .filter((g) => g.parent_id === parent)
      .map((group) => {
        const descendants = groupDescendants(groups, group.id);
        const all = items.filter((i) =>
          descendants.has(i.group_id ?? UNGROUPED),
        );
        const rows = (grouped.get(group.id) ?? []).filter(matches);
        if (search && !all.some(matches)) return null;
        const open =
          !!search || expanded.has(group.id) || activeGroup === group.id;
        const limit = limits[group.id] ?? 60;
        return (
          <li key={group.id}>
            <div
              className={`group flex min-w-0 items-center rounded-md ${activeGroup === group.id ? 'bg-muted' : 'hover:bg-muted/60'}`}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={open}
                onClick={() => {
                  setExpanded((old) => {
                    const next = new Set(old);
                    if (open) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  });
                  onGroup(open && activeGroup === group.id ? '' : group.id);
                }}
              >
                {open ? (
                  <ChevronDown className="size-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0" />
                )}
                {open ? (
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span
                  className="min-w-0 flex-1 truncate font-medium"
                  title={group.name}
                >
                  {group.name}
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {search ? all.filter(matches).length : all.length}
                </span>
                {group.builtin && (
                  <LockKeyhole
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-label="固定分组"
                  />
                )}
              </button>
              {canEdit && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="mr-1 size-6 shrink-0"
                      aria-label={`${group.name}分组操作`}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onSelect={() =>
                        onAction({ type: 'create', parent_id: group.id })
                      }
                    >
                      新建子组
                    </DropdownMenuItem>
                    {!group.builtin && (
                      <>
                        <DropdownMenuItem
                          onSelect={() => onAction({ type: 'edit', group })}
                        >
                          重命名 / 移动
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onSelect={() => onAction({ type: 'delete', group })}
                        >
                          删除分组
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {open && (
              <ul className="ml-3 space-y-0.5 border-l pl-2">
                {branch(group.id, depth + 1)}
                {rows.slice(0, limit).map((item) => (
                  <li key={item.id}>{itemRow(item)}</li>
                ))}
                {rows.length > limit && (
                  <li>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs"
                      onClick={() =>
                        setLimits((old) => ({
                          ...old,
                          [group.id]: limit + 100,
                        }))
                      }
                    >
                      显示更多（剩余 {rows.length - limit}）
                    </Button>
                  </li>
                )}
                {!rows.length &&
                  !groups.some((g) => g.parent_id === group.id) && (
                    <li className="px-2 py-3 text-xs text-muted-foreground">
                      此组暂无因子
                    </li>
                  )}
              </ul>
            )}
          </li>
        );
      });
  }
  return (
    <nav aria-label="因子分组" className="px-2 pb-3">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-xs text-muted-foreground">
          分组 · {items.length} 个因子
        </span>
        {canEdit && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="新建因子组"
            onClick={() => onAction({ type: 'create', parent_id: null })}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>
      <ul className="space-y-1">{branch(null)}</ul>
      {search && !items.some(matches) && (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          没有匹配的因子
        </p>
      )}
    </nav>
  );
}
